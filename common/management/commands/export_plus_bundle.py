import json
from pathlib import Path
from typing import Any

from core.models import Activity
from django.core.management.base import BaseCommand, CommandError
from public_portal.models import ResultRelease
from singer_contest.models import (
    ContestRound,
    CriterionScore,
    GroupStage,
    ScoreRecord,
    SingerRegistration,
    StageResult,
)
from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession


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

        participant_by_singer = {
            row.pk: f"legacy-user:{row.user_id or row.pk}" for row in formal
        }
        round_rows = list(
            ContestRound.objects.filter(activity=activity).order_by("sequence", "pk")
        )
        rounds = []
        unsupported: list[dict[str, Any]] = []
        for round_row in round_rows:
            scores_for_round = list(
                ScoreRecord.objects.filter(round=round_row, is_test_data=False)
            )
            judges = {record.judge_id for record in scores_for_round}
            judge_count = round_row.judge_count or max(len(judges), 1)
            state_map = {
                "draft": "prepared",
                "prepared": "prepared",
                "scoring": "scoring",
                "locked": "locked",
            }
            rounds.append(
                {
                    "legacyId": round_row.pk,
                    "key": f"round-{round_row.pk}",
                    "sequence": round_row.sequence,
                    "judgeCount": judge_count,
                    "minimumJudges": round_row.minimum_judge_count or judge_count,
                    "completion": round_row.score_completion_mode,
                    "scoringMethod": round_row.scoring_mode,
                    "advanceCount": round_row.advance_count or 1,
                    "state": state_map.get(round_row.status, "prepared"),
                }
            )

        rubric_criteria: list[dict[str, Any]] = []
        rubric_rounds = [row for row in round_rows if row.rubric_id is not None]
        if rubric_rounds:
            first = rubric_rounds[0]
            rubric_criteria = [
                {
                    "key": criterion.name,
                    "weight": 1,
                    "maximum": float(criterion.max_score),
                    "minimum": 0,
                }
                for criterion in first.rubric.criteria.filter(is_test_data=False).order_by("sequence")
            ]
            if len({row.rubric_id for row in rubric_rounds}) > 1:
                unsupported.append(
                    {
                        "kind": "multiple_rubrics",
                        "reason": "v2 releases carry one rubric; the first round's rubric was used.",
                    }
                )
        if not rubric_criteria:
            rubric_criteria = [{"key": "总分", "weight": 1, "maximum": 100, "minimum": 0}]

        formal_scores = list(
            ScoreRecord.objects.filter(round__activity=activity, is_test_data=False)
            .select_related("round", "singer", "judge")
            .order_by("round__sequence", "singer_id", "judge_id")
        )
        missing_breakdown = 0
        scores = []
        for record in formal_scores:
            criteria = {
                criterion_score.criterion.name: float(criterion_score.value)
                for criterion_score in CriterionScore.objects.filter(
                    score_record=record, is_test_data=False
                ).select_related("criterion")
            }
            if not criteria:
                criteria = {"总分": float(record.score)}
                missing_breakdown += 1
            source = record.source
            if source == "import":
                source = "paper_dr"
                unsupported.append(
                    {
                        "kind": "score_source_import_mapped",
                        "legacyId": record.pk,
                        "reason": "v2 has no 'import' score source; mapped to paper_dr.",
                    }
                )
            scores.append(
                {
                    "legacyId": record.pk,
                    "roundLegacyId": record.round_id,
                    "contestantKey": participant_by_singer.get(record.singer_id, f"legacy-user:{record.singer_id}"),
                    "judgeId": f"legacy-judge:{record.judge_id}",
                    "panelLegacyId": record.panel_snapshot_id,
                    "total": str(record.score),
                    "criteria": criteria,
                    "source": source,
                    "notes": record.notes,
                    "createdAt": activity.updated_at.isoformat(),
                }
            )
        if missing_breakdown > 0:
            unsupported.append(
                {
                    "kind": "criterion_breakdown_missing",
                    "reason": f"{missing_breakdown} score records only have a total.",
                }
            )

        group_stages = GroupStage.objects.filter(activity=activity).count()
        if group_stages > 0:
            unsupported.append(
                {
                    "kind": "group_stage",
                    "reason": f"{group_stages} group-chorus stages have no v2 representation.",
                }
            )
        excluded_scores = ScoreRecord.objects.filter(
            round__activity=activity, is_test_data=True
        ).count()

        vote_sessions = []
        ballots = []
        for vote_session in VoteSession.objects.filter(
            activity=activity, is_test_data=False
        ).order_by("pk"):
            vote_options = list(
                VoteOption.objects.filter(vote_session=vote_session, is_test_data=False)
                .order_by("sort_order", "pk")
            )
            option_ids = {option.pk for option in vote_options}
            vote_sessions.append(
                {
                    "legacyId": vote_session.pk,
                    "name": vote_session.name,
                    "purpose": vote_session.purpose,
                    "selectionType": vote_session.selection_type,
                    "maxSelections": vote_session.max_selections,
                    "identityPolicy": "ticket" if vote_session.requires_ticket else "anonymous",
                    "scoringRule": {"kind": "ballot_share_percent", "scale": 100, "decimals": 2},
                    "status": "open" if vote_session.is_open else "closed",
                    "openedAt": vote_session.start_time.isoformat() if vote_session.start_time else None,
                    "closedAt": None if vote_session.is_open else vote_session.end_time.isoformat() if vote_session.end_time else None,
                    "options": [
                        {
                            "legacyId": option.pk,
                            "candidateKey": participant_by_singer.get(
                                option.singer_id, f"legacy-user:{option.singer_id}"
                            ),
                        }
                        for option in vote_options
                    ],
                }
            )
            for ballot in VoteBallot.objects.filter(
                vote_session=vote_session, is_test_data=False
            ).order_by("pk"):
                selected = sorted(
                    set(
                        VoteRecord.objects.filter(
                            ballot=ballot, is_test_data=False
                        ).values_list("vote_option_id", flat=True)
                    )
                    & option_ids
                )
                ballots.append(
                    {
                        "legacyId": ballot.pk,
                        "sessionLegacyId": vote_session.pk,
                        "optionLegacyIds": selected,
                        "submittedAt": ballot.submitted_at.isoformat(),
                    }
                )
        excluded_ballots = VoteBallot.objects.filter(
            vote_session__activity=activity, is_test_data=True
        ).count()

        stage_results = []
        for stage_result in StageResult.objects.filter(
            activity=activity, status=StageResult.Status.CONFIRMED, is_test_data=False
        ).order_by("pk"):
            decisions = [
                {
                    "rank": decision.rank,
                    "contestantId": participant_by_singer.get(
                        decision.singer_id, f"legacy-user:{decision.singer_id}"
                    ),
                    "score": str(decision.score),
                }
                for decision in stage_result.decisions.filter(
                    is_test_data=False, rank__isnull=False
                ).order_by("rank")
            ]
            awards = [
                {
                    "award": award.name,
                    "contestantId": participant_by_singer.get(
                        award.singer_id, f"legacy-user:{award.singer_id}"
                    ),
                }
                for award in stage_result.award_decisions.filter(is_test_data=False).order_by("pk")
            ]
            stage_results.append(
                {
                    "stageKey": stage_result.stage_key,
                    "status": "confirmed",
                    "decisions": decisions,
                    "awards": awards,
                    "confirmedAt": (
                        stage_result.confirmed_at or stage_result.computed_at
                    ).isoformat(),
                }
            )
        releases = [
            {
                "stageKey": release.stage_result.stage_key,
                "status": release.status,
                "snapshot": release.result_snapshot,
                "resultVersion": release.result_version,
                "postVersion": release.post_version,
                "note": release.note,
                "releasedAt": release.released_at.isoformat(),
            }
            for release in ResultRelease.objects.filter(
                stage_result__activity=activity,
                stage_result__is_test_data=False,
            ).select_related("stage_result").order_by("released_at", "pk")
            if release.result_snapshot
        ]

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
            "rubric": {"criteria": rubric_criteria, "tiePolicy": "review"},
            "rounds": rounds,
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
            "roster": {
                "status": "final" if rounds else "unknown",
                "approvedCount": formal.filter(pre_status="approved").count() if rounds else 0,
                "finalizedAt": activity.updated_at.isoformat() if rounds else None,
            },
            "materials": [],
            "competition": {
                "panels": [],
                "seats": [],
                "performances": [],
                "scores": scores,
                "rankings": [],
            },
            "voting": {"sessions": vote_sessions, "ballots": ballots},
            "results": {"stageResults": stage_results, "releases": releases},
            "counts": {
                "registrations": formal.count(),
                "approvedRegistrations": formal.filter(pre_status="approved").count(),
                "materials": 0,
                "rounds": len(rounds),
                "scores": len(scores),
                "ballots": len(ballots),
                "releases": len(releases),
            },
            "excluded": {
                "testRegistrations": excluded,
                "testScores": excluded_scores,
                "testBallots": excluded_ballots,
                "testMaterials": 0,
            },
            "unsupported": unsupported,
        }

        target = Path(options["output"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(bundle, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        self.stdout.write(self.style.SUCCESS(f"Wrote {target}"))
