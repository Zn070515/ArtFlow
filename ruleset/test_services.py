from django.test import SimpleTestCase

from ruleset.services import validate_definition_completeness


class DefinitionCompletenessTests(SimpleTestCase):
    def test_roster_only_definition_is_incomplete(self):
        issues = validate_definition_completeness(
            {
                "schema_version": 1,
                "nodes": [{"key": "roster", "type": "ROSTER"}],
            }
        )

        self.assertEqual({issue.code for issue in issues}, {"RULESET_INCOMPLETE"})

    def test_scoring_graph_without_checkpoints_is_complete_enough(self):
        issues = validate_definition_completeness(
            {
                "schema_version": 1,
                "nodes": [
                    {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
                    {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                    {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},
                ],
            }
        )

        self.assertEqual(issues, ())
