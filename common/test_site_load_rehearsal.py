"""The site-load rehearsal fixture, proved by running it.

The fixture freezes its ruleset and only then prepares the first round, because a round may
only run under the format that is officially current for its activity. That ordering *is*
the reason the command still works — the earlier version prepared the round while the
ruleset was still an unbound draft — and a marker-in-the-source test cannot see it. This
runs the command and asks the database what it produced.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from django.core.management import call_command
from django.test import TestCase
from ruleset.models import RulesetVersion
from singer_contest.models import ContestRound


class SiteLoadRehearsalFixtureTests(TestCase):
    def test_the_fixture_freezes_the_format_before_it_starts_the_round(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "manifest.json"

            call_command("prepare_site_load_rehearsal", output_file=str(output))

            manifest = json.loads(output.read_text(encoding="utf-8"))

        version = RulesetVersion.objects.get(pk=manifest["ruleset_version_id"])
        self.assertEqual(version.status, RulesetVersion.Status.FROZEN)
        self.assertTrue(version.is_current)

        contest_round = ContestRound.objects.get(pk=manifest["rounds"]["r1"])
        self.assertEqual(contest_round.status, ContestRound.Status.PREPARED)
        # The round the venue is handed is the one the frozen binding names, which is what
        # makes it runnable at all.
        bound_ids = {int(value) for value in (version.binding or {}).get("round_keys", {}).values()}
        self.assertIn(contest_round.pk, bound_ids)
