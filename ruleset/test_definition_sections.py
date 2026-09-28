"""Section-scoped definition patching (P0-A).

``RulesetVersion.definition`` is a JSON *document*, not a node list. The template library
already writes ``checkpoints`` beside ``nodes``, and the Ruleset-driven Questionnaire phase
adds ``context`` and ``questionnaire`` next to them. Every editor patches exactly one of
those sections through :func:`ruleset.services.update_ruleset_definition_section` and must
get every sibling back byte-identical — an editor that rebuilds the whole root from the one
section it owns deletes the others on each save.

The HTTP-level half of this contract (the node editor's add / move / delete / save actions)
lives in ``staff_panel.tests.RulesetDefinitionRootPreservationTests``.
"""

import json

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, RULESET_FREEZE, authority_write
from core.models import Activity
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import TestCase

from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.schema import content_hash
from ruleset.services import DEFINITION_SECTIONS, update_ruleset_definition_section
from ruleset.templates import golden_schidui

SIBLINGS = ("checkpoints", "context", "questionnaire")


class DefinitionSectionPatchTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="section-admin", password="pass", role=User.Role.ADMIN
            )
        self.activity = self._make_activity("院十佳-section")
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="section规则",
            is_test_data=True,
            created_by=self.operator,
        )
        self.root = self._root_with_sections()
        self.version = self._make_version(self.root)

    @staticmethod
    def _root_with_sections():
        """The real 2025 golden graph (stage1/stage2/stage3 checkpoints) plus both extra sections."""
        root = json.loads(golden_schidui())
        root["context"] = {"audience_rule": "2026"}
        root["questionnaire"] = {"schema_version": 1, "key": "singer_submission", "pages": []}
        return root

    def _make_activity(self, title):
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title=title,
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=True,
            )

    def _make_version(self, root):
        return RulesetVersion.objects.create(
            ruleset=self.ruleset,
            definition=json.dumps(root, ensure_ascii=False),
            created_by=self.operator,
        )

    def _stored(self):
        self.version.refresh_from_db()
        return json.loads(self.version.definition)

    def _patch(self, section, value, **kwargs):
        return update_ruleset_definition_section(
            self.version, section=section, value=value, operator=self.operator, **kwargs
        )

    def _assert_siblings_untouched(self, stale, changed_section):
        stored = self._stored()
        self.assertEqual(
            sorted(stored), sorted(self.root), "section patch must not add or drop root keys"
        )
        for section in SIBLINGS:
            if section == changed_section:
                continue
            self.assertEqual(
                stored.get(section), stale.get(section), f"patch destroyed the {section!r} section"
            )

    def test_patching_nodes_preserves_every_sibling_section(self):
        stale = self._stored()
        patched = [*stale["nodes"], {"key": "extra", "type": "ASSESS", "source": "entry"}]
        self._patch("nodes", patched)
        self.assertEqual(len(self._stored()["nodes"]), len(stale["nodes"]) + 1)
        self._assert_siblings_untouched(stale, "nodes")

    def test_patching_questionnaire_preserves_nodes_and_checkpoints(self):
        """The gate row the Questionnaire phase depends on: a questionnaire save is a
        one-section patch, so it can never delete the flow graph or its checkpoints."""
        stale = self._stored()
        self._patch("questionnaire", {"schema_version": 1, "key": "q2", "pages": []})
        self.assertEqual(self._stored()["questionnaire"]["key"], "q2")
        self._assert_siblings_untouched(stale, "questionnaire")

    def test_patching_checkpoints_preserves_nodes_and_questionnaire(self):
        stale = self._stored()
        self._patch("checkpoints", [{"key": "stage1", "output": "top10"}])
        self.assertEqual(self._stored()["checkpoints"], [{"key": "stage1", "output": "top10"}])
        self._assert_siblings_untouched(stale, "checkpoints")

    def test_patching_context_preserves_other_sections(self):
        stale = self._stored()
        self._patch("context", {"audience_rule": "2027"})
        self.assertEqual(self._stored()["context"], {"audience_rule": "2027"})
        self._assert_siblings_untouched(stale, "context")

    def test_unknown_section_is_rejected(self):
        self.assertRaises(ValidationError, self._patch, "schema_version", 2)
        self.assertEqual(sorted(self._stored()), sorted(self.root))

    def test_patch_revalidates_the_whole_document(self):
        """A section patch may not persist a graph ``parse_definition`` would reject."""
        stale = self._stored()
        broken = [{"key": "a", "type": "RANK", "source": "b"}]
        self.assertRaises(ValidationError, self._patch, "nodes", broken)
        self.assertEqual(self._stored()["nodes"], stale["nodes"])

    def test_content_hash_tracks_a_section_patch(self):
        """P2's prerequisite: the questionnaire lives inside ``definition``, so editing a
        question already moves ``content_hash`` — no separate questionnaire authority."""
        before = self._stored()
        self._patch("questionnaire", {"schema_version": 1, "key": "q2", "pages": []})
        self.version.refresh_from_db()
        self.assertNotEqual(self.version.content_hash, content_hash(before))
        self.assertEqual(self.version.content_hash, content_hash(self._stored()))

    def test_stale_content_hash_rejects_a_section_patch(self):
        stale = self._stored()
        self.assertRaises(
            ValidationError,
            self._patch,
            "questionnaire",
            {"schema_version": 1, "key": "q2", "pages": []},
            base_content_hash="0" * 64,
        )
        self.assertEqual(self._stored(), stale)

    def test_frozen_version_rejects_every_section_patch(self):
        self.version.status = RulesetVersion.Status.FROZEN
        with authority_write(RULESET_FREEZE):
            self.version.save(update_fields=["status"])
        stale = self._stored()
        for section in DEFINITION_SECTIONS:
            with self.subTest(section=section):
                self.assertRaises(PermissionDenied, self._patch, section, None)
        self.assertEqual(self._stored(), stale)
