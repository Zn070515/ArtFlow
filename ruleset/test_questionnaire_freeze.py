"""P2 — the questionnaire freezes with the ruleset, and stays decoupled from scoring.

The questionnaire lives *inside* ``RulesetVersion.definition``, so it inherits the freeze's
authority for free: ``content_hash`` canonicalises the whole document, so editing one
question moves the ruleset hash and, through it, the authority hash a StageResult is
audited under. Freeze therefore has to compile both DSLs — the flow graph and the
questionnaire — and validate the one fact neither can see alone: a question may only bind
a round the ruleset actually binds.

The boundary the other two cases protect is the one the whole phase exists for:

- changing only the questionnaire must leave the resolved board **identical** — answers
  never feed the scorer;
- changing only the flow must leave the compiled questionnaire **identical** — the two
  compilers stay independent even though they freeze together.
"""

import json

from common.authority import authority_write
from django.core.exceptions import ValidationError
from questionnaire.compiler import compile_questionnaire
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric, SingerRegistration

from ruleset.editor import preview_definition
from ruleset.schema import ENTRY_KEY
from ruleset.services import (
    freeze_ruleset_version,
    supersede_ruleset_version,
    update_ruleset_definition_section,
)
from ruleset.test_schema import _RulesetModelBase

from .models import ContestRuleset, RulesetVersion


def _without_digests(value):
    """Drop every content-derived digest from a resolved board.

    A definition change legitimately moves every hash inside the result; what must not
    move is what the contest actually decided.
    """
    if isinstance(value, dict):
        return {
            k: _without_digests(v)
            for k, v in value.items()
            if "hash" not in k and "fingerprint" not in k
        }
    if isinstance(value, list | tuple):
        return [_without_digests(v) for v in value]
    return value


def _flow_definition():
    """assess_r1 → rank → top2, over the bound round ``r1``."""
    return json.dumps(
        {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "top2", "type": "SELECT", "source": "rank1", "count": 2},
            ],
        },
        ensure_ascii=False,
    )


def _questionnaire(*, label="第一轮曲目", round_key="r1", due_round="r1", key="singer_submission"):
    return {
        "schema_version": 1,
        "key": key,
        "pages": [
            {
                "key": "basic",
                "title": "基本信息",
                "sections": [
                    {
                        "key": "identity",
                        "title": "身份",
                        "questions": [
                            {
                                "key": "name",
                                "type": "text",
                                "label": "姓名",
                                "binding": "registration.name",
                            },
                            {
                                "key": "r1.song",
                                "type": "text",
                                "label": label,
                                "round": round_key,
                                "due": {"mode": "before_round", "round": due_round},
                            },
                        ],
                    }
                ],
            }
        ],
    }


class _QuestionnaireFreezeBase(_RulesetModelBase):
    """An activity with r1/r2 bound, three approved singers, and a DRAFT version."""

    def ruleset(self, *, definition=None):
        activity = self.make_activity(is_test_mode=True, title="问卷冻结")
        ruleset = ContestRuleset.objects.create(activity=activity, name="RS", is_test_data=True)
        binding = {}
        for key in ("r1", "r2"):
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
                username=f"quest-{activity.pk}-{i}",
                student_id=f"70{i:04d}",
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=True,
            )
        return ruleset

    def version(self, ruleset, definition):
        return RulesetVersion.objects.create(
            ruleset=ruleset, definition=definition, created_by=self._operator()
        )

    def _operator(self):
        from accounts.models import User
        from common.authority import ACCOUNT_AUTHORITY

        cached = getattr(self, "_operator_user", None)
        if cached is not None:
            return cached
        user = self.make_user(f"quest-admin-{id(self)}")
        user.role = User.Role.ADMIN
        with authority_write(ACCOUNT_AUTHORITY):
            user.save()
        self._operator_user = user
        return user


class QuestionnaireFreezeGateTests(_QuestionnaireFreezeBase):
    def test_a_ruleset_with_a_valid_questionnaire_freezes(self):
        ruleset = self.ruleset()
        root = json.loads(_flow_definition())
        root["questionnaire"] = _questionnaire()
        frozen = freeze_ruleset_version(
            self.version(ruleset, json.dumps(root, ensure_ascii=False)), self._operator()
        )
        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)

    def test_freeze_rejects_an_invalid_questionnaire(self):
        """The flow graph can be perfect while the questionnaire is not — both must pass."""
        ruleset = self.ruleset()
        root = json.loads(_flow_definition())
        broken = _questionnaire()
        broken["pages"][0]["sections"][0]["questions"][1]["key"] = "name"  # duplicate
        root["questionnaire"] = broken
        with self.assertRaises(ValidationError):
            freeze_ruleset_version(
                self.version(ruleset, json.dumps(root, ensure_ascii=False)), self._operator()
            )

    def test_freeze_rejects_a_question_binding_an_unbound_round(self):
        ruleset = self.ruleset()
        root = json.loads(_flow_definition())
        root["questionnaire"] = _questionnaire(round_key="r9", due_round="r9")
        with self.assertRaises(ValidationError) as caught:
            freeze_ruleset_version(
                self.version(ruleset, json.dumps(root, ensure_ascii=False)), self._operator()
            )
        self.assertIn("r9", str(caught.exception))

    def test_freeze_rejects_a_qualification_condition_on_an_unbound_round(self):
        """`qualified.r9` is well-shaped and still answers nothing.

        A misspelled or optimistic round key made the condition False forever, hiding the
        question (or dropping its required-ness) for the whole contest with no error — the
        static vocabulary in `conditions` cannot catch it, because only the binding knows
        which rounds exist.
        """
        ruleset = self.ruleset()
        root = json.loads(_flow_definition())
        questionnaire = _questionnaire()
        question = questionnaire["pages"][0]["sections"][0]["questions"][1]
        question["visible_if"] = {
            "source": "context",
            "key": "qualified.r9",
            "op": "eq",
            "value": True,
        }
        root["questionnaire"] = questionnaire
        with self.assertRaises(ValidationError) as caught:
            freeze_ruleset_version(
                self.version(ruleset, json.dumps(root, ensure_ascii=False)), self._operator()
            )
        self.assertIn("r9", str(caught.exception))

    def test_freeze_accepts_a_qualification_condition_on_a_bound_round(self):
        ruleset = self.ruleset()
        root = json.loads(_flow_definition())
        questionnaire = _questionnaire()
        question = questionnaire["pages"][0]["sections"][0]["questions"][1]
        question["required_if"] = {
            "source": "context",
            "key": "qualified.r2",
            "op": "eq",
            "value": True,
        }
        root["questionnaire"] = questionnaire
        frozen = freeze_ruleset_version(
            self.version(ruleset, json.dumps(root, ensure_ascii=False)), self._operator()
        )
        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)

    def test_a_bound_round_may_carry_material_without_a_score_node(self):
        """r2 is bound but no node scores it: a round that is only materials is legal, so
        the cross-domain check must not demand an ASSESS node."""
        ruleset = self.ruleset()
        root = json.loads(_flow_definition())
        root["questionnaire"] = _questionnaire(round_key="r2", due_round="r2")
        frozen = freeze_ruleset_version(
            self.version(ruleset, json.dumps(root, ensure_ascii=False)), self._operator()
        )
        self.assertEqual(frozen.status, RulesetVersion.Status.FROZEN)

    def test_a_questionnaire_section_patch_is_schema_validated(self):
        """The builder's JSON save must reject a bad questionnaire at save time, not only
        at freeze."""
        ruleset = self.ruleset()
        version = self.version(ruleset, _flow_definition())
        broken = _questionnaire()
        broken["pages"][0]["sections"][0]["questions"][0]["binding"] = "registration.pre_status"
        with self.assertRaises(ValidationError):
            update_ruleset_definition_section(
                version,
                section="questionnaire",
                value=broken,
                operator=self._operator(),
            )


class QuestionnaireAuthorityTests(_QuestionnaireFreezeBase):
    def _frozen(self, *, label):
        ruleset = self.ruleset()
        root = json.loads(_flow_definition())
        root["questionnaire"] = _questionnaire(label=label)
        version = self.version(ruleset, json.dumps(root, ensure_ascii=False))
        freeze_ruleset_version(version, self._operator())
        version.refresh_from_db()
        return version

    def test_a_label_change_moves_content_hash_and_authority_hash(self):
        first = self._frozen(label="第一轮曲目")
        second = self._frozen(label="换个标签")
        self.assertNotEqual(first.content_hash, second.content_hash)
        self.assertNotEqual(first.authority_hash, second.authority_hash)

    def test_frozen_questionnaire_cannot_be_patched(self):
        from django.core.exceptions import PermissionDenied

        version = self._frozen(label="第一轮曲目")
        with self.assertRaises(PermissionDenied):
            update_ruleset_definition_section(
                version,
                section="questionnaire",
                value=_questionnaire(label="篡改"),
                operator=self._operator(),
            )

    def test_supersede_copies_the_questionnaire_verbatim(self):
        version = self._frozen(label="第一轮曲目")
        successor = supersede_ruleset_version(version, created_by=self._operator())
        successor.refresh_from_db()
        original = json.loads(version.definition)
        copied = json.loads(successor.definition)
        self.assertEqual(copied["questionnaire"], original["questionnaire"])
        self.assertEqual(copied["nodes"], original["nodes"])


class QuestionnaireDecouplingTests(_QuestionnaireFreezeBase):
    """The two compilers freeze together but must not leak into each other."""

    def test_a_questionnaire_change_leaves_the_resolved_board_identical(self):
        first = json.loads(_flow_definition())
        first["questionnaire"] = _questionnaire(label="第一轮曲目")
        second = json.loads(_flow_definition())
        second["questionnaire"] = _questionnaire(label="换个标签")

        _report_a, _plan_a, board_a = preview_definition(first)
        _report_b, _plan_b, board_b = preview_definition(second)
        assert board_a is not None
        assert board_b is not None
        # The resolved outcome is identical...
        self.assertEqual(_without_digests(board_a.to_dict()), _without_digests(board_b.to_dict()))
        # ...while the authority surface moves, because editing a question *is* editing
        # the frozen ruleset. Both halves matter: answers never score, and the hash still
        # tracks them.
        self.assertNotEqual(board_a.content_hash, board_b.content_hash)

    def test_a_flow_change_leaves_the_compiled_questionnaire_identical(self):
        raw = _questionnaire()
        questionnaire_hash = compile_questionnaire(raw).schema_hash

        changed_flow = json.loads(_flow_definition())
        changed_flow["nodes"][2]["count"] = 1
        changed_flow["questionnaire"] = raw

        self.assertEqual(
            compile_questionnaire(changed_flow["questionnaire"]).schema_hash, questionnaire_hash
        )

    def test_questionnaire_rounds_are_read_from_the_plan(self):
        """The cross-domain check's input: exactly the rounds the questionnaire references."""
        from questionnaire.cross_domain import referenced_round_keys

        plan = compile_questionnaire(_questionnaire(round_key="r2", due_round="r2"))
        self.assertEqual(referenced_round_keys(plan), frozenset({"r2"}))
