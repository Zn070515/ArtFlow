import json

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    RULESET_FREEZE,
    SINGER_CONTESTANT_NUMBER,
    authority_write,
)
from core.models import Activity
from django.core.exceptions import ValidationError
from django.test import TestCase
from files.models import MaterialCheck
from files.services import reconcile_questionnaire_material_checks, review_material_check
from questionnaire.compiler import compile_questionnaire
from questionnaire.services import get_or_create_response, mark_submitted, save_draft_answers
from ruleset.models import ContestRuleset, RulesetVersion

from .materials import live_material_summary, validate_live_material_contract
from .models import SingerRegistration


def _definition(*, include_r3=True):
    questions = []
    for round_key in ("r2", "r3") if include_r3 else ("r2",):
        questions.extend(
            [
                {
                    "key": f"{round_key}.song",
                    "label": f"{round_key} 歌曲",
                    "type": "text",
                    "round": round_key,
                    "required": True,
                },
                {
                    "key": f"{round_key}.accompaniment",
                    "label": f"{round_key} 伴奏",
                    "type": "file",
                    "round": round_key,
                    "required": True,
                    "file": {
                        "purpose": "accompaniment",
                        "extensions": [".mp3"],
                        "max_mb": 100,
                    },
                },
            ]
        )
    return {
        "schema_version": 1,
        "nodes": [{"key": "roster", "type": "ROSTER"}],
        "questionnaire": {
            "schema_version": 1,
            "key": "singer_submission",
            "pages": [
                {
                    "key": "materials",
                    "title": "比赛材料",
                    "sections": [{"key": "songs", "title": "歌曲", "questions": questions}],
                }
            ],
        },
    }


class LiveMaterialProjectionTests(TestCase):
    def test_contract_requires_both_personal_rounds(self):
        version = type("Version", (), {"definition": json.dumps(_definition(include_r3=False))})()
        with self.assertRaises(ValidationError):
            validate_live_material_contract(version)

    def test_contract_requires_song_and_accompaniment_for_each_personal_round(self):
        definition = _definition()
        questions = definition["questionnaire"]["pages"][0]["sections"][0]["questions"]
        definition["questionnaire"]["pages"][0]["sections"][0]["questions"] = [
            question for question in questions if question["key"] != "r2.song"
        ]
        version = type("Version", (), {"definition": json.dumps(definition)})()

        with self.assertRaisesMessage(ValidationError, "r2 必须有必填歌曲材料"):
            validate_live_material_contract(version)

    def test_summary_separates_second_and_third_round_personal_checks(self):
        with authority_write(ACCOUNT_AUTHORITY):
            user = User.objects.create_user(username="material-singer", password="pass")
        with authority_write(ACTIVITY_STATE):
            activity = Activity.objects.create(
                title="Materials",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        singer = SingerRegistration.objects.create(
            activity=activity,
            user=user,
            name="材料选手",
            student_id="material-1",
            college="艺术学院",
            class_name="一班",
            phone="13900000001",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        with authority_write(SINGER_CONTESTANT_NUMBER):
            singer.official_number = 1
            singer.save(update_fields=["official_number", "updated_at"])
        ruleset = ContestRuleset.objects.create(
            activity=activity, name="Materials", is_test_data=True
        )
        with authority_write(RULESET_FREEZE):
            version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                definition=json.dumps(_definition()),
                authority_hash="b" * 64,
                binding={},
            )
        for key, status in (
            ("r2.song", MaterialCheck.Status.APPROVED),
            ("r2.accompaniment", MaterialCheck.Status.APPROVED),
            ("r3.song", MaterialCheck.Status.APPROVED),
            ("r3.accompaniment", MaterialCheck.Status.MISSING),
        ):
            MaterialCheck.objects.create(
                singer_registration=singer,
                item_name=key,
                question_key=key,
                status=status,
                required=True,
                source_ruleset_version=version,
            )

        summary = live_material_summary(activity, version=version)
        self.assertEqual(summary["first_round"]["total_count"], 0)
        self.assertEqual(summary["personal_rounds"]["r2"]["ready_count"], 1)
        self.assertEqual(summary["personal_rounds"]["r3"]["ready_count"], 0)
        self.assertEqual(
            summary["personal_rounds"]["r3"]["participants"][0]["missing"],
            ["r3.accompaniment"],
        )

    def test_missing_checks_are_not_reported_ready_and_keep_contract_labels(self):
        with authority_write(ACCOUNT_AUTHORITY):
            user = User.objects.create_user(username="material-missing", password="pass")
        with authority_write(ACTIVITY_STATE):
            activity = Activity.objects.create(
                title="Missing materials",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        SingerRegistration.objects.create(
            activity=activity,
            user=user,
            name="未交材料",
            student_id="material-missing-1",
            college="艺术学院",
            class_name="一班",
            phone="13900000002",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        ruleset = ContestRuleset.objects.create(
            activity=activity, name="Missing materials", is_test_data=True
        )
        with authority_write(RULESET_FREEZE):
            version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                definition=json.dumps(_definition()),
                authority_hash="c" * 64,
                binding={},
            )

        summary = live_material_summary(activity, version=version)
        participant = summary["personal_rounds"]["r3"]["participants"][0]

        self.assertFalse(participant["ready"])
        self.assertEqual(participant["missing"], ["r3 歌曲", "r3 伴奏"])
        self.assertEqual(
            [item.get("item_name") for item in participant["items"]],
            ["r3 歌曲", "r3 伴奏"],
        )

    def test_submitted_questionnaire_songs_flow_into_reviewable_material_checks(self):
        with authority_write(ACCOUNT_AUTHORITY):
            staff = User.objects.create_user(
                username="material-review-staff", password="pass", role=User.Role.STAFF
            )
            participant = User.objects.create_user(username="material-submitter", password="pass")
        with authority_write(ACTIVITY_STATE):
            activity = Activity.objects.create(
                title="Submitted materials",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=True,
            )
        singer = SingerRegistration.objects.create(
            activity=activity,
            user=participant,
            name="已提交选手",
            student_id="material-submitted-1",
            college="艺术学院",
            class_name="一班",
            phone="13900000003",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        ruleset = ContestRuleset.objects.create(
            activity=activity, name="Submitted materials", is_test_data=True
        )
        with authority_write(RULESET_FREEZE):
            version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                definition=json.dumps(_definition()),
                authority_hash="d" * 64,
                binding={},
            )
        plan = compile_questionnaire(_definition()["questionnaire"])
        response = get_or_create_response(
            registration=singer,
            ruleset_version=version,
            questionnaire_key=plan.key,
            schema_hash=plan.schema_hash,
            is_test_data=True,
        )
        response = save_draft_answers(
            response,
            answers={
                "r2.song": "已提交踢馆曲",
                "r3.song": "已提交决赛曲",
            },
            schema_hash=plan.schema_hash,
        )
        mark_submitted(response)

        checks = reconcile_questionnaire_material_checks(
            registration=singer,
            version=version,
            plan=plan,
        )
        by_key = {check.question_key: check for check in checks}
        self.assertEqual(by_key["r2.song"].status, MaterialCheck.Status.UPLOADED)
        self.assertEqual(by_key["r3.song"].status, MaterialCheck.Status.UPLOADED)
        self.assertEqual(by_key["r2.accompaniment"].status, MaterialCheck.Status.MISSING)
        review_material_check(
            by_key["r2.song"], status=MaterialCheck.Status.APPROVED, note="歌曲已核对", actor=staff
        )
        review_material_check(
            by_key["r3.song"], status=MaterialCheck.Status.APPROVED, note="歌曲已核对", actor=staff
        )
        self.assertEqual(
            list(
                singer.material_checks.filter(question_key__endswith=".song").values_list(
                    "status", flat=True
                )
            ),
            [MaterialCheck.Status.APPROVED, MaterialCheck.Status.APPROVED],
        )
