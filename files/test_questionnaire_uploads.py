"""P5 — a question, not a purpose, is the identity of an uploaded answer file.

The old uniqueness was ``(registration, file_purpose)``, so a participant could hold
exactly one accompaniment — which makes "one accompaniment per round" unrepresentable and
is why the questionnaire could not be built on top of it. A questionnaire upload is instead
identified by the question it answers, and the technical ``file_purpose`` becomes an
output of that question rather than an input from the browser: the caller names a question,
and the current FROZEN questionnaire decides which purpose it accepts.

Legacy uploads keep their old identity. Nothing about a farewell-show program or a
purpose-identified singer upload changes.
"""

import json
import tempfile
from unittest.mock import patch
from uuid import uuid4

from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.test_characterization import _CharacterizationBase
from core.models import Activity
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError
from django.test import override_settings
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric, SingerRegistration

from .models import MaterialCheck, SubmissionFile
from .services import delete_submission_file, store_questionnaire_file, store_submission_file

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00"


def _file_question(key, round_key):
    return {
        "key": key,
        "type": "file",
        "label": key,
        "round": round_key,
        "required": True,
        "file": {
            "purpose": "accompaniment",
            "extensions": [".mp3"],
            "max_mb": 100,
            "max_files": 1,
        },
    }


def _questionnaire():
    return {
        "schema_version": 1,
        "key": "singer_submission",
        "pages": [
            {
                "key": "material",
                "title": "材料",
                "sections": [
                    {
                        "key": "rounds",
                        "title": "各轮材料",
                        "questions": [
                            _file_question("r1.accompaniment", "r1"),
                            _file_question("r2.accompaniment", "r2"),
                            _file_question("r3.accompaniment", "r3"),
                            _file_question("r4.accompaniment", "r4"),
                            {"key": "stage.note", "type": "text", "label": "备注"},
                        ],
                    }
                ],
            }
        ],
    }


def _definition():
    return json.dumps(
        {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "top2", "type": "SELECT", "source": "rank1", "count": 2},
            ],
        },
        ensure_ascii=False,
    )


def _upload(name="take.mp3"):
    return SimpleUploadedFile(name, MP3, content_type="audio/mpeg")


def _wav_upload(name="take.wav"):
    return SimpleUploadedFile(
        name,
        b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * 16,
        content_type="audio/wav",
    )


class _QuestionnaireUploadBase(_CharacterizationBase):
    def setUp(self):
        super().setUp()
        # The upload throttle lives in the locmem cache keyed on reused pks.
        cache.clear()
        self.media_root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()
        self.addCleanup(self.override.disable)

    def operator(self):
        from accounts.models import User

        cached = getattr(self, "_operator_user", None)
        if cached is not None:
            return cached
        user = self.make_user(f"upl-admin-{uuid4().hex[:8]}")
        user.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        self._operator_user = user
        return user

    def frozen_version(self, *, include_questionnaire=True):
        # Registration is open: a questionnaire answer file is a registration-time upload,
        # and the write authority is the phase, not the response's status.
        activity = self.make_activity(
            is_test_mode=True,
            phase=Activity.Phase.REGISTRATION_OPEN,
            title=f"上传-{uuid4().hex[:6]}",
        )
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=True)
        binding = {}
        for key in ("r1", "r2", "r3", "r4"):
            rubric = ScoringRubric.objects.create(
                activity=activity, name=f"{key}评分", is_test_data=True
            )
            RubricCriterion.objects.create(
                rubric=rubric, name="总分", max_score=100, is_test_data=True
            )
            contest_round = ContestRound.objects.create(
                activity=activity, round_type=ContestRound.RoundType.PRELIMINARY, name=key
            )
            contest_round.rubric = rubric
            contest_round.save(update_fields=["rubric"])
            binding[key] = contest_round.pk
        ruleset.round_keys = binding
        ruleset.save(update_fields=["round_keys"])
        for i in range(3):
            self.make_singer(
                activity,
                username=f"upl-field-{activity.pk}-{i}",
                student_id=f"60{i:04d}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
        root = json.loads(_definition())
        if include_questionnaire:
            root["questionnaire"] = _questionnaire()
        version = RulesetVersion.objects.create(
            ruleset=ruleset, definition=json.dumps(root, ensure_ascii=False)
        )
        freeze_ruleset_version(version, self.operator())
        version.refresh_from_db()
        return version

    def registration(self, version, index=1):
        return self.make_singer(
            version.ruleset.activity,
            username=f"upl-singer-{uuid4().hex[:8]}",
            student_id=f"61{index:04d}",
            pre_status=SingerRegistration.PreStatus.DRAFT,
            is_test_data=True,
        )


class QuestionnaireUploadIdentityTests(_QuestionnaireUploadBase):
    def test_four_rounds_of_accompaniments_can_exist_at_once(self):
        version = self.frozen_version()
        registration = self.registration(version)
        for key in ("r1.accompaniment", "r2.accompaniment", "r3.accompaniment", "r4.accompaniment"):
            store_questionnaire_file(
                registration=registration,
                question_key=key,
                uploaded_file=_upload(f"{key}.mp3"),
                actor=self.operator(),
            )
        current = SubmissionFile.objects.filter(
            singer_registration=registration, is_current=True
        ).values_list("question_key", flat=True)
        self.assertEqual(
            sorted(current),
            [
                "r1.accompaniment",
                "r2.accompaniment",
                "r3.accompaniment",
                "r4.accompaniment",
            ],
        )

    def test_replacing_one_round_leaves_the_others_current(self):
        version = self.frozen_version()
        registration = self.registration(version)
        for key in ("r1.accompaniment", "r2.accompaniment", "r3.accompaniment"):
            store_questionnaire_file(
                registration=registration,
                question_key=key,
                uploaded_file=_upload(f"{key}.mp3"),
                actor=self.operator(),
            )
        store_questionnaire_file(
            registration=registration,
            question_key="r2.accompaniment",
            uploaded_file=_upload("r2-v2.mp3"),
            actor=self.operator(),
        )
        current = set(
            SubmissionFile.objects.filter(
                singer_registration=registration, is_current=True
            ).values_list("question_key", flat=True)
        )
        self.assertEqual(
            current,
            {"r1.accompaniment", "r2.accompaniment", "r3.accompaniment"},
        )
        r2 = SubmissionFile.objects.filter(
            singer_registration=registration, question_key="r2.accompaniment"
        )
        self.assertEqual(r2.count(), 2)
        self.assertEqual(r2.filter(is_current=True).get().version, 2)

    def test_versions_are_counted_per_question(self):
        version = self.frozen_version()
        registration = self.registration(version)
        store_questionnaire_file(
            registration=registration,
            question_key="r1.accompaniment",
            uploaded_file=_upload(),
            actor=self.operator(),
        )
        second = store_questionnaire_file(
            registration=registration,
            question_key="r2.accompaniment",
            uploaded_file=_upload(),
            actor=self.operator(),
        )
        self.assertEqual(second.version, 1)

    def test_the_stored_purpose_comes_from_the_question(self):
        """There is no purpose parameter on the way in — the question is the only input."""
        version = self.frozen_version()
        registration = self.registration(version)
        created = store_questionnaire_file(
            registration=registration,
            question_key="r1.accompaniment",
            uploaded_file=_upload(),
            actor=self.operator(),
        )
        self.assertEqual(created.file_purpose, SubmissionFile.Purpose.ACCOMPANIMENT)

    def test_the_upload_records_the_version_it_answered(self):
        version = self.frozen_version()
        registration = self.registration(version)
        created = store_questionnaire_file(
            registration=registration,
            question_key="r1.accompaniment",
            uploaded_file=_upload(),
            actor=self.operator(),
        )
        self.assertEqual(created.source_ruleset_version_id, version.pk)


class QuestionnaireUploadRefusalTests(_QuestionnaireUploadBase):
    def _store(self, registration, key, **kwargs):
        return store_questionnaire_file(
            registration=registration,
            question_key=key,
            uploaded_file=_upload(),
            actor=self.operator(),
            **kwargs,
        )

    def test_an_unknown_question_key_is_refused(self):
        version = self.frozen_version()
        registration = self.registration(version)
        with self.assertRaises(ValidationError):
            self._store(registration, "r9.accompaniment")

    def test_a_question_that_is_not_a_file_question_is_refused(self):
        version = self.frozen_version()
        registration = self.registration(version)
        with self.assertRaises(ValidationError):
            self._store(registration, "stage.note")

    def test_the_questions_own_size_cap_is_enforced(self):
        version = self.frozen_version()
        registration = self.registration(version)
        oversized = SimpleUploadedFile("big.mp3", MP3 + b"\x00" * (101 * 1024 * 1024))
        with self.assertRaises(ValidationError):
            store_questionnaire_file(
                registration=registration,
                question_key="r1.accompaniment",
                uploaded_file=oversized,
                actor=self.operator(),
            )

    def test_the_question_extension_allowlist_is_enforced(self):
        version = self.frozen_version()
        registration = self.registration(version)
        with self.assertRaises(ValidationError):
            store_questionnaire_file(
                registration=registration,
                question_key="r1.accompaniment",
                uploaded_file=_wav_upload(),
                actor=self.operator(),
            )

    def test_a_stale_schema_hash_is_refused(self):
        from questionnaire.schema import schema_hash

        version = self.frozen_version()
        registration = self.registration(version)
        self._store(
            registration, "r1.accompaniment", expected_schema_hash=schema_hash(_questionnaire())
        )
        with self.assertRaises(ValidationError):
            self._store(registration, "r2.accompaniment", expected_schema_hash="0" * 64)


class QuestionnaireUploadSubmissionTests(_QuestionnaireUploadBase):
    def test_uploaded_files_satisfy_the_required_file_questions(self):
        """The file branch of the answer resolver, end to end: four required file
        questions are answered by four stored files, and the registration completes."""
        from questionnaire.registration import submit_registration

        version = self.frozen_version()
        registration = self.registration(version)
        for key in (
            "r1.accompaniment",
            "r2.accompaniment",
            "r3.accompaniment",
            "r4.accompaniment",
        ):
            store_questionnaire_file(
                registration=registration,
                question_key=key,
                uploaded_file=_upload(f"{key}.mp3"),
                actor=self.operator(),
            )
        response = submit_registration(
            version=version,
            registration=registration,
            answers={},
            due_rounds=frozenset({"r1", "r2", "r3", "r4"}),
        )
        self.assertEqual(response.status, "submitted")
        registration.refresh_from_db()
        self.assertEqual(registration.pre_status, SingerRegistration.PreStatus.SUBMITTED)

    def test_a_missing_required_file_still_blocks_submission(self):
        from questionnaire.registration import submit_registration

        version = self.frozen_version()
        registration = self.registration(version)
        with self.assertRaises(ValidationError):
            submit_registration(
                version=version,
                registration=registration,
                answers={},
                due_rounds=frozenset({"r1", "r2", "r3", "r4"}),
            )


class QuestionnaireUploadReviewTests(_QuestionnaireUploadBase):
    def test_replacing_a_question_resets_only_that_questions_review(self):
        """Matching on purpose alone would clear the review of all four rounds at once."""
        version = self.frozen_version()
        registration = self.registration(version)
        for key in ("r1.accompaniment", "r2.accompaniment"):
            MaterialCheck.objects.create(
                singer_registration=registration,
                item_name=key,
                question_key=key,
                file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                status=MaterialCheck.Status.APPROVED,
                reviewed_by=self.operator(),
            )
        store_questionnaire_file(
            registration=registration,
            question_key="r2.accompaniment",
            uploaded_file=_upload(),
            actor=self.operator(),
        )
        self.assertEqual(
            MaterialCheck.objects.get(question_key="r2.accompaniment").status,
            MaterialCheck.Status.UPLOADED,
        )
        self.assertEqual(
            MaterialCheck.objects.get(question_key="r1.accompaniment").status,
            MaterialCheck.Status.APPROVED,
        )

    def test_deleting_a_question_file_promotes_only_that_questions_history(self):
        version = self.frozen_version()
        registration = self.registration(version)
        for key in ("r1.accompaniment", "r2.accompaniment"):
            store_questionnaire_file(
                registration=registration,
                question_key=key,
                uploaded_file=_upload(f"{key}-v1.mp3"),
                actor=self.operator(),
            )
            store_questionnaire_file(
                registration=registration,
                question_key=key,
                uploaded_file=_upload(f"{key}-v2.mp3"),
                actor=self.operator(),
            )
        r2_current = SubmissionFile.objects.get(
            singer_registration=registration, question_key="r2.accompaniment", is_current=True
        )
        delete_submission_file(r2_current)
        self.assertTrue(
            SubmissionFile.objects.get(
                singer_registration=registration,
                question_key="r2.accompaniment",
                version=1,
            ).is_current
        )
        self.assertTrue(
            SubmissionFile.objects.get(
                singer_registration=registration,
                question_key="r1.accompaniment",
                version=2,
            ).is_current
        )


class MaterialCheckQuestionIdentityTests(_QuestionnaireUploadBase):
    def _check(self, registration, *, question_key="", item_name="伴奏", status=None, **kwargs):
        return MaterialCheck.objects.create(
            singer_registration=registration,
            item_name=item_name,
            question_key=question_key,
            file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            status=status or MaterialCheck.Status.MISSING,
            **kwargs,
        )

    def test_a_questionnaire_check_is_unique_per_question(self):
        version = self.frozen_version()
        registration = self.registration(version)
        self._check(registration, question_key="r1.accompaniment")
        self._check(registration, question_key="r2.accompaniment")
        self.assertEqual(MaterialCheck.objects.filter(singer_registration=registration).count(), 2)

    def test_the_same_question_cannot_carry_two_checks(self):
        from django.db import IntegrityError, transaction

        version = self.frozen_version()
        registration = self.registration(version)
        self._check(registration, question_key="r1.accompaniment")
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self._check(registration, question_key="r1.accompaniment")

    def test_a_legacy_check_is_still_unique_per_item_name(self):
        from django.db import IntegrityError, transaction

        version = self.frozen_version()
        registration = self.registration(version)
        self._check(registration)
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self._check(registration)

    def test_a_questionnaire_check_does_not_collide_with_a_legacy_one(self):
        version = self.frozen_version()
        registration = self.registration(version)
        self._check(registration)
        self._check(registration, question_key="r1.accompaniment")
        self.assertEqual(MaterialCheck.objects.filter(singer_registration=registration).count(), 2)

    def test_the_missing_label_reads_as_unsubmitted(self):
        """A check can stand for a text answer, so neither label may say "uploaded"."""
        self.assertEqual(MaterialCheck.Status.MISSING.label, "未提交")
        self.assertEqual(MaterialCheck.Status.UPLOADED.label, "已提交，待审核")


class ParticipantQuestionnaireUploadTests(_QuestionnaireUploadBase):
    def _supplement_scenario(self):
        from common.authority import ACTIVITY_STATE

        version = self.frozen_version()
        registration = self.registration(version)
        checks = {}
        for key in ("r1.accompaniment", "r2.accompaniment"):
            checks[key] = MaterialCheck.objects.create(
                singer_registration=registration,
                item_name=key,
                question_key=key,
                file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                status=MaterialCheck.Status.APPROVED,
            )
        activity = version.ruleset.activity
        with authority_write(ACTIVITY_STATE):
            activity.phase = Activity.Phase.REGISTRATION_CLOSED
            activity.save(update_fields=["phase"])
        return version, registration, checks, activity

    def test_a_supplement_on_one_question_opens_only_that_question(self):
        from files.services import participant_uploadable_check_ids

        _version, registration, checks, _activity = self._supplement_scenario()
        checks["r2.accompaniment"].status = MaterialCheck.Status.NEEDS_SUPPLEMENT
        checks["r2.accompaniment"].save(update_fields=["status"])
        self.assertEqual(
            participant_uploadable_check_ids(registration),
            {checks["r2.accompaniment"].pk},
        )

    def test_a_crafted_post_against_an_ungranted_question_writes_nothing(self):
        from files.services import submit_participant_material_for_check

        _version, registration, checks, _activity = self._supplement_scenario()
        checks["r2.accompaniment"].status = MaterialCheck.Status.NEEDS_SUPPLEMENT
        checks["r2.accompaniment"].save(update_fields=["status"])
        with self.assertRaises(ValidationError):
            submit_participant_material_for_check(
                owner=registration,
                check_id=checks["r1.accompaniment"].pk,
                uploaded_file=_upload(),
                actor=registration.user,
            )
        self.assertEqual(SubmissionFile.objects.filter(singer_registration=registration).count(), 0)

    def test_a_granted_question_accepts_the_replacement(self):
        from files.services import submit_participant_material_for_check

        _version, registration, checks, _activity = self._supplement_scenario()
        checks["r2.accompaniment"].status = MaterialCheck.Status.NEEDS_SUPPLEMENT
        checks["r2.accompaniment"].save(update_fields=["status"])
        created = submit_participant_material_for_check(
            owner=registration,
            check_id=checks["r2.accompaniment"].pk,
            uploaded_file=_upload(),
            actor=registration.user,
        )
        self.assertEqual(created.question_key, "r2.accompaniment")


class QuestionnaireMaterialCheckReconcileTests(_QuestionnaireUploadBase):
    """The checks staff review are produced from the questionnaire, not created by hand.

    Before this, the only place a questionnaire check came into existence was a test
    setting one up itself -- so the production path had none, the staff detail page showed
    an empty material list, and a supplement could never be granted.
    """

    def _open(self, version, index=1):
        from questionnaire.registration import get_or_create_draft_registration

        registration = self.registration(version, index)
        get_or_create_draft_registration(version=version, user=registration.user)
        return registration

    def _checks(self, registration):
        return {
            check.question_key: check
            for check in MaterialCheck.objects.filter(singer_registration=registration)
        }

    def test_the_first_open_produces_one_check_per_question(self):
        version = self.frozen_version()
        registration = self._open(version)
        self.assertEqual(
            sorted(self._checks(registration)),
            [
                "r1.accompaniment",
                "r2.accompaniment",
                "r3.accompaniment",
                "r4.accompaniment",
                "stage.note",
            ],
        )

    def test_a_file_question_check_snapshots_its_purpose(self):
        version = self.frozen_version()
        registration = self._open(version)
        self.assertEqual(
            self._checks(registration)["r1.accompaniment"].file_purpose,
            SubmissionFile.Purpose.ACCOMPANIMENT,
        )

    def test_a_text_question_check_has_no_purpose(self):
        version = self.frozen_version()
        registration = self._open(version)
        self.assertEqual(self._checks(registration)["stage.note"].file_purpose, "")

    def test_the_check_records_the_version_it_belongs_to(self):
        version = self.frozen_version()
        registration = self._open(version)
        self.assertEqual(
            self._checks(registration)["stage.note"].source_ruleset_version_id, version.pk
        )

    def test_everything_starts_missing(self):
        version = self.frozen_version()
        registration = self._open(version)
        self.assertEqual(
            {check.status for check in self._checks(registration).values()},
            {MaterialCheck.Status.MISSING},
        )

    def test_an_upload_marks_only_its_own_question(self):
        from questionnaire.registration import questionnaire_plan

        from files.services import reconcile_questionnaire_material_checks

        version = self.frozen_version()
        registration = self._open(version)
        store_questionnaire_file(
            registration=registration,
            question_key="r2.accompaniment",
            uploaded_file=_upload(),
            actor=self.operator(),
        )
        reconcile_questionnaire_material_checks(
            registration=registration, version=version, plan=questionnaire_plan(version)
        )
        checks = self._checks(registration)
        self.assertEqual(checks["r2.accompaniment"].status, MaterialCheck.Status.UPLOADED)
        self.assertEqual(checks["r1.accompaniment"].status, MaterialCheck.Status.MISSING)

    def test_an_answered_text_question_marks_its_check(self):
        from questionnaire.registration import questionnaire_plan, save_draft

        from files.services import reconcile_questionnaire_material_checks

        version = self.frozen_version()
        registration = self._open(version)
        save_draft(version=version, registration=registration, answers={"stage.note": "备注"})
        reconcile_questionnaire_material_checks(
            registration=registration, version=version, plan=questionnaire_plan(version)
        )
        self.assertEqual(
            self._checks(registration)["stage.note"].status, MaterialCheck.Status.UPLOADED
        )

    def test_staff_review_state_survives_a_reconcile(self):
        from questionnaire.registration import questionnaire_plan, save_draft

        from files.services import reconcile_questionnaire_material_checks

        version = self.frozen_version()
        registration = self._open(version)
        save_draft(version=version, registration=registration, answers={"stage.note": "备注"})
        reconcile_questionnaire_material_checks(
            registration=registration, version=version, plan=questionnaire_plan(version)
        )
        check = self._checks(registration)["stage.note"]
        check.status = MaterialCheck.Status.APPROVED
        check.reviewed_by = self.operator()
        check.save(update_fields=["status", "reviewed_by"])

        reconcile_questionnaire_material_checks(
            registration=registration,
            version=version,
            plan=questionnaire_plan(version),
        )
        refreshed = self._checks(registration)["stage.note"]
        self.assertEqual(refreshed.status, MaterialCheck.Status.APPROVED)

    def test_blanking_an_approved_answer_returns_the_check_to_missing(self):
        """An approval is of a thing that exists; the thing going away invalidates it."""
        from questionnaire.registration import questionnaire_plan, save_draft

        from files.services import reconcile_questionnaire_material_checks

        version = self.frozen_version()
        registration = self._open(version)
        save_draft(version=version, registration=registration, answers={"stage.note": "备注"})
        reconcile_questionnaire_material_checks(
            registration=registration, version=version, plan=questionnaire_plan(version)
        )
        check = self._checks(registration)["stage.note"]
        check.status = MaterialCheck.Status.APPROVED
        check.save(update_fields=["status"])

        save_draft(version=version, registration=registration, answers={"stage.note": ""})
        reconcile_questionnaire_material_checks(
            registration=registration, version=version, plan=questionnaire_plan(version)
        )
        self.assertEqual(
            self._checks(registration)["stage.note"].status, MaterialCheck.Status.MISSING
        )

    def test_a_renamed_question_keeps_its_check(self):
        """The key is the identity; the label is a snapshot that follows it."""
        from questionnaire.compiler import compile_questionnaire

        from files.services import reconcile_questionnaire_material_checks

        version = self.frozen_version()
        registration = self._open(version)
        before = self._checks(registration)["stage.note"].pk

        document = _questionnaire()
        for question in document["pages"][0]["sections"][0]["questions"]:
            if question["key"] == "stage.note":
                question["label"] = "改过的备注"
        reconcile_questionnaire_material_checks(
            registration=registration,
            version=version,
            plan=compile_questionnaire(document),
        )
        refreshed = self._checks(registration)["stage.note"]
        self.assertEqual(refreshed.pk, before)
        self.assertEqual(refreshed.item_name, "改过的备注")

    def test_a_removed_question_loses_its_check(self):
        from questionnaire.compiler import compile_questionnaire

        from files.services import reconcile_questionnaire_material_checks

        version = self.frozen_version()
        registration = self._open(version)
        document = _questionnaire()
        questions = document["pages"][0]["sections"][0]["questions"]
        document["pages"][0]["sections"][0]["questions"] = [
            q for q in questions if q["key"] != "stage.note"
        ]
        reconcile_questionnaire_material_checks(
            registration=registration,
            version=version,
            plan=compile_questionnaire(document),
        )
        self.assertNotIn("stage.note", self._checks(registration))

    def test_a_changed_file_purpose_drops_the_review(self):
        from questionnaire.compiler import compile_questionnaire

        from files.services import reconcile_questionnaire_material_checks

        version = self.frozen_version()
        registration = self._open(version)
        check = self._checks(registration)["r1.accompaniment"]
        check.status = MaterialCheck.Status.APPROVED
        check.reviewed_by = self.operator()
        check.save(update_fields=["status", "reviewed_by"])

        document = _questionnaire()
        for question in document["pages"][0]["sections"][0]["questions"]:
            if question["key"] == "r1.accompaniment":
                question["file"]["purpose"] = "background_video"
                question["file"]["extensions"] = [".mp4"]
                question["file"]["max_mb"] = 500
        reconcile_questionnaire_material_checks(
            registration=registration,
            version=version,
            plan=compile_questionnaire(document),
        )
        refreshed = self._checks(registration)["r1.accompaniment"]
        self.assertEqual(refreshed.status, MaterialCheck.Status.MISSING)
        self.assertIsNone(refreshed.reviewed_by)

    def test_the_checks_are_what_a_supplement_is_granted_on(self):
        """The flow the checks exist for: staff send one question back, and only that one
        reopens for the participant."""
        from questionnaire.registration import save_draft

        version = self.frozen_version()
        registration = self._open(version)
        check = self._checks(registration)["r1.accompaniment"]
        check.status = MaterialCheck.Status.NEEDS_SUPPLEMENT
        check.save(update_fields=["status"])

        from common.authority import ACTIVITY_STATE

        activity = version.ruleset.activity
        with authority_write(ACTIVITY_STATE):
            activity.phase = Activity.Phase.REGISTRATION_CLOSED
            activity.save(update_fields=["phase"])

        store_questionnaire_file(
            registration=registration,
            question_key="r1.accompaniment",
            uploaded_file=_upload(),
            actor=self.operator(),
        )
        with self.assertRaises(ValidationError):
            store_questionnaire_file(
                registration=registration,
                question_key="r2.accompaniment",
                uploaded_file=_upload(),
                actor=self.operator(),
            )
        with self.assertRaises(ValidationError):
            save_draft(version=version, registration=registration, answers={"stage.note": "改"})


class LegacyUploadUnchangedTests(_QuestionnaireUploadBase):
    def test_a_legacy_upload_still_has_no_question_key(self):
        version = self.frozen_version(include_questionnaire=False)
        registration = self.registration(version)
        created = store_submission_file(
            owner=registration,
            uploaded_file=_upload(),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.operator(),
        )
        self.assertEqual(created.question_key, "")
        self.assertIsNone(created.source_ruleset_version_id)

    def test_a_legacy_upload_still_replaces_itself_by_purpose(self):
        version = self.frozen_version(include_questionnaire=False)
        registration = self.registration(version)
        store_submission_file(
            owner=registration,
            uploaded_file=_upload(),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.operator(),
        )
        store_submission_file(
            owner=registration,
            uploaded_file=_upload(),
            purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
            uploaded_by=self.operator(),
        )
        self.assertEqual(SubmissionFile.objects.filter(singer_registration=registration).count(), 2)
        self.assertEqual(
            SubmissionFile.objects.filter(
                singer_registration=registration, is_current=True
            ).count(),
            1,
        )

    def test_a_legacy_upload_is_refused_for_a_questionnaire_registration(self):
        version = self.frozen_version()
        registration = self.registration(version)
        with self.assertRaises(ValidationError):
            store_submission_file(
                owner=registration,
                uploaded_file=_upload(),
                purpose=SubmissionFile.Purpose.ACCOMPANIMENT,
                uploaded_by=self.operator(),
            )


class QuestionnaireUploadCompensationTests(_QuestionnaireUploadBase):
    """Storage is not a transaction participant, and the caller's unit of work is bigger
    than the row.

    `_store_file` writes the bytes before the row that names them can commit, and
    `store_questionnaire_file` writes an audit row *after* the upload in the same
    transaction. A failure in either place rolled the row back and left the bytes: the
    application could not see them, the volume still held them, and the low-water check
    that refuses uploads when free space runs out still counted them.
    """

    def _stored_files(self):
        from pathlib import Path

        return [path for path in Path(self.media_root).rglob("*") if path.is_file()]

    def test_a_failing_insert_removes_the_bytes_it_already_wrote(self):
        version = self.frozen_version()
        registration = self.registration(version)

        with patch.object(SubmissionFile, "save", side_effect=IntegrityError("insert refused")):
            with self.assertRaisesMessage(IntegrityError, "insert refused"):
                store_questionnaire_file(
                    registration=registration,
                    question_key="r1.accompaniment",
                    uploaded_file=_upload(),
                    actor=self.operator(),
                )

        self.assertFalse(SubmissionFile.objects.filter(singer_registration=registration))
        self.assertEqual(self._stored_files(), [])

    def test_a_failure_after_the_upload_removes_the_bytes_too(self):
        version = self.frozen_version()
        registration = self.registration(version)

        with patch("common.models.AuditLog.objects.create", side_effect=RuntimeError("audit down")):
            with self.assertRaisesMessage(RuntimeError, "audit down"):
                store_questionnaire_file(
                    registration=registration,
                    question_key="r1.accompaniment",
                    uploaded_file=_upload(),
                    actor=self.operator(),
                )

        self.assertFalse(SubmissionFile.objects.filter(singer_registration=registration))
        self.assertEqual(self._stored_files(), [])

    def test_the_successful_upload_keeps_its_object(self):
        version = self.frozen_version()
        registration = self.registration(version)

        stored = store_questionnaire_file(
            registration=registration,
            question_key="r1.accompaniment",
            uploaded_file=_upload(),
            actor=self.operator(),
        )

        self.assertTrue(stored.file.storage.exists(stored.file.name))
        self.assertEqual(len(self._stored_files()), 1)
