import json
from pathlib import Path
from typing import Any

from core.models import Activity
from django.core.management.base import BaseCommand, CommandError
from singer_contest.models import SingerRegistration


class Command(BaseCommand):
    help = "Export one v1 activity as a versioned ArtFlow-Plus import bundle."
    requires_system_checks = []

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--activity", required=True, help="Activity public code.")
        parser.add_argument("--output", required=True, help="Destination JSON path.")

    def handle(self, *args: Any, **options: Any) -> None:
        activity = Activity.objects.filter(public_code=options["activity"]).first()
        if activity is None:
            raise CommandError("Activity not found.")
        registrations = SingerRegistration.objects.filter(activity=activity)
        formal = registrations.filter(is_test_data=False)
        excluded = registrations.filter(is_test_data=True).count()

        bundle = {
            "format": "artflow-plus-legacy-bundle",
            "version": 1,
            "exportedAt": activity.updated_at.isoformat(),
            "source": {
                "publicCode": activity.public_code,
                "activityId": activity.pk,
                "v1Version": "1.0.2",
            },
            "activity": {
                "publicCode": activity.public_code,
                "title": activity.title,
                "subtitle": activity.subtitle,
                "activityType": activity.activity_type,
                "phase": activity.phase,
                "createdAt": activity.created_at.isoformat(),
            },
            "questionnaire": {
                "version": "legacy-v1",
                "questions": [
                    {"key": "name", "label": "姓名", "type": "text", "required": True},
                    {"key": "student_id", "label": "学号", "type": "text", "required": True},
                    {"key": "college", "label": "学院", "type": "text", "required": True},
                    {"key": "class_name", "label": "班级", "type": "text", "required": True},
                    {"key": "phone", "label": "手机", "type": "text", "required": True},
                    {"key": "wechat", "label": "微信", "type": "text", "required": False},
                    {"key": "song", "label": "曲目", "type": "text", "required": False},
                    {"key": "description", "label": "自我介绍", "type": "textarea", "required": False},
                ],
            },
            "ruleset": {"present": False, "raw": {}},
            "rubric": {
                "criteria": [{"key": "总分", "weight": 1, "maximum": 100, "minimum": 0}],
                "tiePolicy": "review",
            },
            "rounds": [],
            "registrations": [
                {
                    "legacyId": row.pk,
                    "participantKey": f"legacy-user:{row.user_id or row.pk}",
                    "status": row.pre_status,
                    "answers": {
                        "name": row.name,
                        "student_id": row.student_id,
                        "college": row.college,
                        "class_name": row.class_name,
                        "phone": row.phone,
                        "wechat": row.wechat,
                        "song": row.song_name,
                        "description": row.description,
                    },
                    "reviewNote": row.remark,
                    "reviewedBy": None,
                    "createdAt": row.created_at.isoformat(),
                    "liveStatus": row.live_status,
                }
                for row in formal.order_by("pk")
            ],
            "roster": {"status": "unknown", "approvedCount": 0, "finalizedAt": None},
            "materials": [],
            "competition": {
                "panels": [],
                "seats": [],
                "performances": [],
                "scores": [],
                "rankings": [],
            },
            "voting": {"sessions": [], "ballots": []},
            "results": {"stageResults": [], "releases": []},
            "counts": {
                "registrations": formal.count(),
                "approvedRegistrations": formal.filter(pre_status="approved").count(),
                "materials": 0,
                "rounds": 0,
                "scores": 0,
                "ballots": 0,
                "releases": 0,
            },
            "excluded": {
                "testRegistrations": excluded,
                "testScores": 0,
                "testBallots": 0,
                "testMaterials": 0,
            },
            "unsupported": [],
        }

        target = Path(options["output"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(bundle, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        self.stdout.write(self.style.SUCCESS(f"Wrote {target}"))
