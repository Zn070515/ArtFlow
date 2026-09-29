"""Create a private synthetic FORMAL activity for the participant browser flow."""

from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, CONTEST_ROUND_STATE, authority_write
from core.models import Activity
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import freeze_ruleset_version
from singer_contest.models import ContestRound, RubricCriterion, ScoringRubric


class Command(BaseCommand):
    help = "Create an isolated non-production questionnaire browser fixture."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--output-file",
            required=True,
            help="Write fixture credentials to this private temporary file.",
        )
        parser.add_argument(
            "--formal-fixture",
            action="store_true",
            help=(
                "Explicitly allow a synthetic FORMAL activity so the browser can exercise "
                "the real participant boundary; never allowed in production."
            ),
        )

    def handle(self, *args, **options) -> None:
        if settings.APP_ENV == "production":
            raise CommandError("Questionnaire browser fixtures are disabled in production.")
        if not options["formal_fixture"]:
            raise CommandError(
                "The participant browser fixture requires --formal-fixture in non-production."
            )
        output_path = Path(options["output_file"]).expanduser()
        if output_path.exists():
            raise CommandError(f"Refusing to overwrite fixture file: {output_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        username = f"questionnaire-e2e-{uuid4().hex[:12]}"
        password = f"Questionnaire-E2E-{uuid4().hex}!"
        with transaction.atomic():
            operator = self._create_operator()
            activity = self._create_activity()
            self._create_ruleset(activity, operator)
            participant = self._create_participant(username, password)

        output_path.write_text(
            json.dumps(
                {
                    "activity_id": activity.pk,
                    "username": participant.username,
                    "password": password,
                },
                ensure_ascii=True,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        try:
            os.chmod(output_path, 0o600)
        except OSError:
            pass
        self.stdout.write(self.style.SUCCESS("Questionnaire browser fixture prepared."))

    @staticmethod
    def _create_operator() -> User:
        with authority_write(ACCOUNT_AUTHORITY):
            operator = User(
                username=f"questionnaire-e2e-operator-{uuid4().hex}",
                role=User.Role.ADMIN,
                is_staff=True,
                is_superuser=True,
            )
            operator.set_unusable_password()
            operator.save()
        return operator

    @staticmethod
    def _create_participant(username: str, password: str) -> User:
        with authority_write(ACCOUNT_AUTHORITY):
            participant = User(username=username, role=User.Role.PARTICIPANT)
            participant.set_password(password)
            participant.save()
        return participant

    @staticmethod
    def _create_activity() -> Activity:
        with authority_write(ACTIVITY_STATE):
            return Activity.objects.create(
                title="Questionnaire browser fixture activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=False,
            )

    @staticmethod
    def _create_ruleset(activity: Activity, operator: User) -> RulesetVersion:
        rubric = ScoringRubric.objects.create(
            activity=activity,
            name="Questionnaire browser fixture rubric",
            is_test_data=False,
        )
        RubricCriterion.objects.create(
            rubric=rubric,
            name="Fixture criterion",
            max_score=100,
            is_test_data=False,
        )
        with authority_write(CONTEST_ROUND_STATE):
            contest_round = ContestRound.objects.create(
                activity=activity,
                round_type=ContestRound.RoundType.PRELIMINARY,
                name="第一轮",
                rubric=rubric,
            )
        ruleset = ContestRuleset.objects.create(
            activity=activity,
            name="Questionnaire browser fixture ruleset",
            round_keys={"r1": contest_round.pk},
            is_test_data=False,
        )
        definition = {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": "entry", "round": "r1"},
            ],
            "questionnaire": {
                "schema_version": 1,
                "key": "singer_submission",
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
                                        "required": True,
                                    },
                                    {
                                        "key": "r1.song",
                                        "type": "text",
                                        "label": "第一轮曲目",
                                        "round": "r1",
                                        "required": True,
                                    },
                                    {
                                        "key": "r1.accompaniment",
                                        "type": "file",
                                        "label": "第一轮伴奏",
                                        "round": "r1",
                                        "file": {
                                            "purpose": "accompaniment",
                                            "extensions": [".wav"],
                                            "max_mb": 10,
                                            "max_files": 1,
                                        },
                                    },
                                ],
                            }
                        ],
                    }
                ],
            },
        }
        version = RulesetVersion.objects.create(
            ruleset=ruleset,
            definition=json.dumps(definition, ensure_ascii=False),
            created_by=operator,
        )
        return freeze_ruleset_version(version, operator)
