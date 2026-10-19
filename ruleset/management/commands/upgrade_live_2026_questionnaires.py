"""Upgrade one existing 2026 live-format DRAFT to the dual-questionnaire shape.

The built-in template now ships a participant questionnaire whose R2/R3 media questions
accept audio or video, plus a group questionnaire. New rulesets get both automatically.
A version created before that change keeps its old definition until an operator upgrades
it; this command is that one-time, auditable step.

It deliberately only touches the newest DRAFT of one activity. A FROZEN version is the
authority and is never rewritten, and a draft that already has responses is refused because
the command changes the questions those responses were filed under.
"""

from __future__ import annotations

import copy
import json

from accounts.models import User
from common.models import AuditLog
from core.models import Activity
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from ruleset.live_format import LIVE_CHALLENGE_FORMAT_KEY
from ruleset.models import ContestRuleset, RulesetVersion
from ruleset.services import newer_ruleset_version, update_ruleset_definition_sections
from ruleset.templates import LIVE_2026_MEDIA_EXTENSIONS, live_2026_group_questionnaire

COMBINED_FILE_CONFIG = {
    "purpose": "accompaniment",
    "accepts": ["performance_video"],
    "extensions": list(LIVE_2026_MEDIA_EXTENSIONS),
    "max_mb": 100,
    "max_files": 1,
}

MEDIA_LABELS = {
    "r2.accompaniment": "踢馆曲目伴奏或演唱视频",
    "r3.accompaniment": "第三轮曲目伴奏或演唱视频",
}


def _questions(document: dict):
    for page in document.get("pages") or []:
        for section in page.get("sections") or []:
            for question in section.get("questions") or []:
                yield question


def _latest_draft(ruleset: ContestRuleset) -> RulesetVersion | None:
    return (
        ruleset.versions.filter(status=RulesetVersion.Status.DRAFT)
        .order_by("-version")
        .first()
    )


class Command(BaseCommand):
    help = (
        "Upgrade a 2026 live-format DRAFT to the combined audio/video personal "
        "questions and add the group questionnaire."
    )

    def add_arguments(self, parser) -> None:
        parser.add_argument("--activity", type=int, required=True)
        parser.add_argument("--operator-username", required=True)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options) -> None:
        activity = Activity.objects.filter(pk=options["activity"]).first()
        if activity is None:
            raise CommandError(f"activity {options['activity']} does not exist")
        operator = User.objects.filter(username=options["operator_username"]).first()
        if operator is None:
            raise CommandError(f"user {options['operator_username']!r} does not exist")
        if not getattr(operator, "is_staff_or_admin", False):
            raise CommandError("operator must be a staff or admin account")
        ruleset = ContestRuleset.objects.filter(activity=activity).first()
        if ruleset is None:
            raise CommandError("activity has no ContestRuleset")
        if (
            str((ruleset.live_challenge or {}).get("format_key") or "")
            != LIVE_CHALLENGE_FORMAT_KEY
        ):
            raise CommandError("activity's ruleset is not the 2026 live format")

        version = _latest_draft(ruleset)
        if version is None:
            raise CommandError("activity has no DRAFT ruleset version")
        newer = newer_ruleset_version(version)
        if newer is not None:
            raise CommandError(
                f"v{version.version} is not the newest version (v{newer.version} exists)"
            )

        from questionnaire.models import QuestionnaireResponse

        if QuestionnaireResponse.objects.filter(ruleset_version=version).exists():
            raise CommandError(
                "the DRAFT already has questionnaire responses; "
                "upgrading would rewrite the questions they were filed under"
            )

        root = json.loads(version.definition)
        participant = root.get("questionnaire")
        if not isinstance(participant, dict):
            raise CommandError("the DRAFT has no participant questionnaire")
        by_key = {str(question.get("key") or ""): question for question in _questions(participant)}
        missing = [key for key in MEDIA_LABELS if key not in by_key]
        if missing:
            raise CommandError(
                "the participant questionnaire is not the 2026 material shape; "
                f"missing {', '.join(missing)}"
            )

        updated_participant = copy.deepcopy(participant)
        changed_questions = []
        for question in _questions(updated_participant):
            key = str(question.get("key") or "")
            if key not in MEDIA_LABELS:
                continue
            if question.get("file") != COMBINED_FILE_CONFIG or question.get(
                "label"
            ) != MEDIA_LABELS[key]:
                changed_questions.append(key)
            question["file"] = copy.deepcopy(COMBINED_FILE_CONFIG)
            question["label"] = MEDIA_LABELS[key]

        existing_group = root.get("group_questionnaire")
        add_group = not isinstance(existing_group, dict)

        if not changed_questions and not add_group:
            self.stdout.write(
                self.style.SUCCESS(
                    f"activity {activity.pk} v{version.version} is already up to date"
                )
            )
            return

        self.stdout.write(f"activity {activity.pk} ({activity.title}) v{version.version}")
        for key in changed_questions:
            self.stdout.write(f"  update {key}: {MEDIA_LABELS[key]} (audio or video)")
        if add_group:
            group = live_2026_group_questionnaire()
            group_keys = [str(question.get("key") or "") for question in _questions(group)]
            self.stdout.write(f"  add group_questionnaire: {', '.join(group_keys)}")
        else:
            self.stdout.write("  keep existing group_questionnaire")

        if options["dry_run"]:
            self.stdout.write(self.style.WARNING("dry run: nothing written"))
            return

        sections: dict[str, object] = {"questionnaire": updated_participant}
        if add_group:
            sections["group_questionnaire"] = live_2026_group_questionnaire()
        old_hash = version.content_hash
        with transaction.atomic():
            updated = update_ruleset_definition_sections(
                version,
                sections=sections,
                operator=operator,
                base_content_hash=old_hash,
            )
            AuditLog.objects.create(
                operator=operator,
                action_type=AuditLog.ActionType.OTHER,
                target=f"RulesetVersion:{updated.pk}",
                old_value=json.dumps(
                    {"content_hash": old_hash, "group_questionnaire": not add_group},
                    ensure_ascii=False,
                ),
                new_value=json.dumps(
                    {
                        "content_hash": updated.content_hash,
                        "changed_questions": changed_questions,
                        "group_questionnaire": True,
                    },
                    ensure_ascii=False,
                ),
                note="upgrade_live_2026_questionnaires",
            )
        self.stdout.write(
            self.style.SUCCESS(
                f"upgraded activity {activity.pk} v{version.version} "
                f"({len(changed_questions)} question(s), group={'added' if add_group else 'kept'})"
            )
        )
