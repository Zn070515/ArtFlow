from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from accounts.models import User
from core.models import Activity
from django.contrib.contenttypes.models import ContentType
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import IntegrityError, transaction
from django.db.models.deletion import Collector, ProtectedError, RestrictedError
from django.utils import timezone
from exports.models import ArticleTemplate
from farewell_show.models import Program
from files.models import SubmissionFile
from incidents.models import IncidentRecord
from public_portal.models import PublicPost
from singer_contest.models import (
    Award,
    ContestRound,
    Judge,
    ScoreRecord,
    ScoreSummary,
    SingerRegistration,
)
from singer_contest.services import prepare_round, reset_test_round_snapshots
from voting.models import VoteOption, VoteRecord, VoteSession

from common.models import SeedRecord

DEMO_ACTIVITY_KEYS = (
    "demo.activity.singer_contest",
    "demo.activity.farewell_show",
)

DEMO_SEED_KEYS = frozenset(
    {
        "demo.user.admin",
        "demo.user.participant",
        *DEMO_ACTIVITY_KEYS,
        "demo.post.singer_contest",
        "demo.post.farewell_show",
        "demo.template.singer_registration",
        "demo.template.program_collection",
        "demo.singer.one",
        "demo.singer.two",
        "demo.program.opening",
        "demo.program.closing",
        "demo.judge.one",
        "demo.judge.two",
        "demo.round.preliminary",
        "demo.score.one.judge_one",
        "demo.score.one.judge_two",
        "demo.score.two.judge_one",
        "demo.score.two.judge_two",
        "demo.summary.one",
        "demo.summary.two",
        "demo.award.one",
        "demo.vote_session.audience_choice",
        "demo.vote_option.one",
        "demo.vote_option.two",
        "demo.vote_record.one",
        "demo.vote_record.two",
        "demo.incident.one",
    }
)

SEED_TIME = timezone.make_aware(datetime(2026, 9, 1, 9, 0))

TEST_DATA_FLAG_FIELDS = {
    Award: "is_test_data",
    IncidentRecord: "is_test",
    Program: "is_test_data",
    ScoreRecord: "is_test_data",
    ScoreSummary: "is_test_data",
    SingerRegistration: "is_test_data",
    SubmissionFile: "is_test_data",
    VoteOption: "is_test_data",
    VoteRecord: "is_test_data",
    VoteSession: "is_test_data",
}

RESET_RUNTIME_ROOTS = (
    (Award, "activity_id__in"),
    (ScoreSummary, "round__activity_id__in"),
    (ScoreRecord, "round__activity_id__in"),
    (VoteSession, "activity_id__in"),
    (IncidentRecord, "activity_id__in"),
    (Program, "activity_id__in"),
    (SingerRegistration, "activity_id__in"),
)


class Command(BaseCommand):
    help = "Create deterministic demo data or remove its flagged runtime rows."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--reset",
            action="store_true",
            help="Remove command-owned flagged demo runtime rows without touching configuration.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        with transaction.atomic():
            if options["reset"]:
                if self._reset_demo_runtime_data():
                    message = "Demo test runtime data reset."
                else:
                    message = "Demo reset retained unsafe runtime data."
            else:
                self._seed_demo_data()
                message = "Demo data seeded."

        self.stdout.write(self.style.SUCCESS(message))

    def _seed_demo_data(self) -> None:
        admin = self._upsert(
            "demo.user.admin",
            User,
            {
                "username": "demo-admin",
                "role": User.Role.ADMIN,
                "is_staff": True,
                "is_superuser": True,
            },
            prepare_create=lambda user: user.set_unusable_password(),
        )
        participant = self._upsert(
            "demo.user.participant",
            User,
            {
                "username": "demo-participant",
                "role": User.Role.PARTICIPANT,
                "is_staff": False,
                "is_superuser": False,
            },
            prepare_create=lambda user: user.set_unusable_password(),
        )
        singer_activity = self._upsert(
            "demo.activity.singer_contest",
            Activity,
            {
                "title": "Demo Singer Contest",
                "subtitle": "A deterministic practice contest",
                "activity_type": Activity.Type.SINGER_CONTEST,
                "phase": Activity.Phase.REGISTRATION_OPEN,
                "description": "Demo-only singer contest configuration.",
                "is_test_mode": True,
            },
        )
        farewell_activity = self._upsert(
            "demo.activity.farewell_show",
            Activity,
            {
                "title": "Demo Farewell Show",
                "subtitle": "A deterministic practice program",
                "activity_type": Activity.Type.FAREWELL_SHOW,
                "phase": Activity.Phase.REHEARSAL,
                "description": "Demo-only farewell show configuration.",
                "is_test_mode": True,
            },
        )
        self._upsert(
            "demo.post.singer_contest",
            PublicPost,
            {
                "title": "Demo Singer Contest Registration",
                "subtitle": "Practice registration announcement",
                "content": "This is deterministic demo content.",
                "post_type": PublicPost.PostType.REGISTRATION_ENTRY,
                "status": PublicPost.Status.PUBLISHED,
                "related_activity": singer_activity,
                "is_pinned": True,
                "sort_order": 1,
                "created_by": admin,
                "updated_by": admin,
                "published_at": SEED_TIME,
            },
        )
        self._upsert(
            "demo.post.farewell_show",
            PublicPost,
            {
                "title": "Demo Farewell Show Collection",
                "subtitle": "Practice program collection announcement",
                "content": "This is deterministic demo content.",
                "post_type": PublicPost.PostType.NORMAL_ARTICLE,
                "status": PublicPost.Status.PUBLISHED,
                "related_activity": farewell_activity,
                "is_pinned": False,
                "sort_order": 2,
                "created_by": admin,
                "updated_by": admin,
                "published_at": SEED_TIME,
            },
        )
        self._upsert(
            "demo.template.singer_registration",
            ArticleTemplate,
            {
                "name": "Demo singer registration template",
                "template_type": ArticleTemplate.TemplateType.SINGER_REGISTRATION,
                "body": "{title}\n{content}\n{sign_off}",
            },
        )
        self._upsert(
            "demo.template.program_collection",
            ArticleTemplate,
            {
                "name": "Demo program collection template",
                "template_type": ArticleTemplate.TemplateType.PROGRAM_COLLECTION,
                "body": "{title}\n{content}\n{sign_off}",
            },
        )
        singer_one = self._upsert(
            "demo.singer.one",
            SingerRegistration,
            {
                "activity": singer_activity,
                "user": participant,
                "name": "Demo Singer One",
                "student_id": "DEMO2026001",
                "college": "Arts College",
                "class_name": "Demo Class A",
                "phone": "13800000001",
                "wechat": "demo-singer-one",
                "song_name": "Demo Song One",
                "is_original": False,
                "description": "Seeded demo singer.",
                "remark": "",
                "pre_status": SingerRegistration.PreStatus.APPROVED,
                "live_status": SingerRegistration.LiveStatus.SCORED,
                "is_test_data": True,
            },
        )
        singer_two = self._upsert(
            "demo.singer.two",
            SingerRegistration,
            {
                "activity": singer_activity,
                "user": participant,
                "name": "Demo Singer Two",
                "student_id": "DEMO2026002",
                "college": "Arts College",
                "class_name": "Demo Class B",
                "phone": "13800000002",
                "wechat": "demo-singer-two",
                "song_name": "Demo Song Two",
                "is_original": True,
                "description": "Seeded demo singer.",
                "remark": "",
                "pre_status": SingerRegistration.PreStatus.APPROVED,
                "live_status": SingerRegistration.LiveStatus.SCORED,
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.program.opening",
            Program,
            {
                "activity": farewell_activity,
                "user": participant,
                "name": "Demo Opening Song",
                "program_type": Program.ProgramType.SONG,
                "contact_name": "Demo Participant",
                "contact_phone": "13800000001",
                "class_name": "Demo Class A",
                "performers": "Demo Participant",
                "estimated_duration": "03:00",
                "description": "Seeded demo opening program.",
                "mic_requirements": "One handheld microphone",
                "prop_requirements": "",
                "special_notes": "",
                "sort_order": 1,
                "status": Program.Status.APPROVED,
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.program.closing",
            Program,
            {
                "activity": farewell_activity,
                "user": participant,
                "name": "Demo Closing Dance",
                "program_type": Program.ProgramType.DANCE,
                "contact_name": "Demo Participant",
                "contact_phone": "13800000001",
                "class_name": "Demo Class A",
                "performers": "Demo Participant",
                "estimated_duration": "04:00",
                "description": "Seeded demo closing program.",
                "mic_requirements": "",
                "prop_requirements": "Open stage",
                "special_notes": "",
                "sort_order": 2,
                "status": Program.Status.APPROVED,
                "is_test_data": True,
            },
        )
        judge_one = self._upsert(
            "demo.judge.one",
            Judge,
            {
                "activity": singer_activity,
                "name": "Demo Judge One",
                "is_active": True,
            },
        )
        judge_two = self._upsert(
            "demo.judge.two",
            Judge,
            {
                "activity": singer_activity,
                "name": "Demo Judge Two",
                "is_active": True,
            },
        )
        contest_round = self._upsert(
            "demo.round.preliminary",
            ContestRound,
            {
                "activity": singer_activity,
                "round_type": ContestRound.RoundType.PRELIMINARY,
                "scoring_mode": ContestRound.ScoringMode.AVERAGE,
                "name": "Demo Preliminary Round",
                "advance_count": 1,
            },
        )
        if contest_round.status == ContestRound.Status.DRAFT:
            if not self._demo_round_candidates_are_owned(
                singer_activity,
                {singer_one.pk, singer_two.pk},
                {judge_one.pk, judge_two.pk},
            ):
                raise CommandError(
                    "Cannot prepare demo round with unowned eligible singers or active judges."
                )
            SingerRegistration.objects.filter(pk__in=[singer_one.pk, singer_two.pk]).update(
                is_test_data=False
            )
            prepare_round(contest_round, admin)
            SingerRegistration.objects.filter(pk__in=[singer_one.pk, singer_two.pk]).update(
                is_test_data=True
            )
        self._upsert(
            "demo.score.one.judge_one",
            ScoreRecord,
            {
                "round": contest_round,
                "singer": singer_one,
                "judge": judge_one,
                "score": Decimal("91.00"),
                "notes": "Demo score",
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.score.one.judge_two",
            ScoreRecord,
            {
                "round": contest_round,
                "singer": singer_one,
                "judge": judge_two,
                "score": Decimal("93.00"),
                "notes": "Demo score",
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.score.two.judge_one",
            ScoreRecord,
            {
                "round": contest_round,
                "singer": singer_two,
                "judge": judge_one,
                "score": Decimal("87.00"),
                "notes": "Demo score",
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.score.two.judge_two",
            ScoreRecord,
            {
                "round": contest_round,
                "singer": singer_two,
                "judge": judge_two,
                "score": Decimal("89.00"),
                "notes": "Demo score",
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.summary.one",
            ScoreSummary,
            {
                "round": contest_round,
                "singer": singer_one,
                "average_score": Decimal("92.000"),
                "rank": 1,
                "is_advanced": True,
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.summary.two",
            ScoreSummary,
            {
                "round": contest_round,
                "singer": singer_two,
                "average_score": Decimal("88.000"),
                "rank": 2,
                "is_advanced": False,
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.award.one",
            Award,
            {
                "activity": singer_activity,
                "singer": singer_one,
                "name": "Demo First Place",
                "is_test_data": True,
            },
        )
        vote_session = self._upsert(
            "demo.vote_session.audience_choice",
            VoteSession,
            {
                "activity": singer_activity,
                "name": "Demo Audience Choice",
                "passcode": "demo-vote",
                "start_time": SEED_TIME,
                "end_time": SEED_TIME + timedelta(hours=2),
                "is_open": True,
                "selection_type": VoteSession.SelectionType.SINGLE,
                "max_selections": 1,
                "is_test_data": True,
            },
        )
        option_one = self._upsert(
            "demo.vote_option.one",
            VoteOption,
            {
                "vote_session": vote_session,
                "singer": singer_one,
                "sort_order": 1,
                "is_test_data": True,
            },
        )
        option_two = self._upsert(
            "demo.vote_option.two",
            VoteOption,
            {
                "vote_session": vote_session,
                "singer": singer_two,
                "sort_order": 2,
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.vote_record.one",
            VoteRecord,
            {
                "vote_session": vote_session,
                "vote_option": option_one,
                "browser_session_key": "demo-browser-session-one",
                "ip_address": "127.0.0.1",
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.vote_record.two",
            VoteRecord,
            {
                "vote_session": vote_session,
                "vote_option": option_two,
                "browser_session_key": "demo-browser-session-two",
                "ip_address": "127.0.0.2",
                "is_test_data": True,
            },
        )
        self._upsert(
            "demo.incident.one",
            IncidentRecord,
            {
                "activity": singer_activity,
                "occurred_at": SEED_TIME,
                "event_type": IncidentRecord.EventType.EQUIPMENT_ISSUE,
                "singer": singer_one,
                "handled_by": admin,
                "resolution": "Demo issue resolved.",
                "remark": "",
                "is_test": True,
            },
        )

    def _reset_demo_runtime_data(self) -> bool:
        activity_ids = self._demo_activity_ids()
        if not activity_ids:
            return True

        with transaction.atomic():
            demo_rounds = ContestRound.objects.select_for_update().filter(
                pk__in=self._owned_ids(ContestRound), activity_id__in=activity_ids
            )
            admin = self._owned_object("demo.user.admin", User)
            owned_singer_ids = set(self._owned_ids(SingerRegistration))
            owned_judge_ids = set(self._owned_ids(Judge))
            try:
                for contest_round in demo_rounds:
                    reset_test_round_snapshots(
                        contest_round,
                        admin,
                        test_only=True,
                        owned_singer_ids=owned_singer_ids,
                        owned_judge_ids=owned_judge_ids,
                    )
            except ValidationError:
                transaction.set_rollback(True)
                return False

            candidates = self._reset_candidates(activity_ids)
            if not all(self._can_delete_safely(candidate) for candidate in candidates):
                transaction.set_rollback(True)
                return False

            for candidate in candidates:
                candidate.delete()
        return True

    def _demo_round_candidates_are_owned(
        self,
        activity: Activity,
        singer_ids: set[int],
        judge_ids: set[int],
    ) -> bool:
        return not (
            SingerRegistration.objects.filter(
                activity=activity,
                pre_status=SingerRegistration.PreStatus.APPROVED,
                is_test_data=False,
            )
            .exclude(pk__in=singer_ids)
            .exists()
            or Judge.objects.filter(activity=activity, is_active=True).exclude(pk__in=judge_ids).exists()
        )

    def _reset_candidates(self, activity_ids: Any) -> list[Any]:
        candidates: list[Any] = []
        for model, activity_lookup in RESET_RUNTIME_ROOTS:
            flag_field = TEST_DATA_FLAG_FIELDS[model]
            filters = {
                activity_lookup: activity_ids,
                flag_field: True,
            }
            candidates.extend(
                model.objects.select_for_update().filter(
                    pk__in=self._owned_ids(model),
                    **filters,
                )
            )
        return candidates

    def _can_delete_safely(self, candidate: Any) -> bool:
        try:
            collector = self._collector_for(candidate)
            self._lock_collected_objects(collector)
            collector = self._collector_for(candidate)
        except (ProtectedError, RestrictedError):
            return False
        return self._collector_contains_only_owned_test_data(collector)

    def _collector_for(self, candidate: Any) -> Any:
        collector = Collector(using=candidate._state.db)
        collector.collect([candidate])
        return collector

    def _lock_collected_objects(self, collector: Any) -> None:
        for model, objects in collector.data.items():
            self._lock_objects(model, objects)
        for queryset in collector.fast_deletes:
            self._lock_objects(queryset.model, queryset)
        for (field, _value), instances_list in collector.field_updates.items():
            for objects in instances_list:
                self._lock_objects(field.model, objects)

    def _lock_objects(self, model: Any, objects: Any) -> None:
        object_ids = {object_.pk for object_ in objects}
        if object_ids:
            list(model.objects.select_for_update().filter(pk__in=object_ids))

    def _collector_contains_only_owned_test_data(self, collector: Any) -> bool:
        for model, objects in collector.data.items():
            if not self._objects_are_owned_test_data(model, objects):
                return False
        for queryset in collector.fast_deletes:
            if not self._objects_are_owned_test_data(queryset.model, queryset):
                return False
        for (field, _value), instances_list in collector.field_updates.items():
            for objects in instances_list:
                if not self._objects_are_owned_test_data(field.model, objects):
                    return False
        return not any(
            objects
            for fields in collector.restricted_objects.values()
            for objects in fields.values()
        )

    def _objects_are_owned_test_data(self, model: Any, objects: Any) -> bool:
        objects = list(objects)
        if not objects:
            return True

        flag_field = TEST_DATA_FLAG_FIELDS.get(model)
        if flag_field is None:
            return False
        if not all(getattr(object_, flag_field) for object_ in objects):
            return False

        content_type = ContentType.objects.get_for_model(model)
        object_ids = {object_.pk for object_ in objects}
        return SeedRecord.objects.filter(
            key__in=DEMO_SEED_KEYS,
            content_type=content_type,
            object_id__in=object_ids,
        ).count() == len(object_ids)

    def _demo_activity_ids(self) -> list[int]:
        activity_type = ContentType.objects.get_for_model(Activity)
        return list(
            SeedRecord.objects.filter(
                key__in=DEMO_ACTIVITY_KEYS,
                content_type=activity_type,
            ).values_list("object_id", flat=True)
        )

    def _owned_ids(self, model: Any) -> Any:
        content_type = ContentType.objects.get_for_model(model)
        return SeedRecord.objects.filter(
            key__in=DEMO_SEED_KEYS,
            content_type=content_type,
        ).values_list("object_id", flat=True)

    def _owned_object(self, key: str, model: Any) -> Any:
        content_type = ContentType.objects.get_for_model(model)
        seed_record = SeedRecord.objects.get(key=key, content_type=content_type)
        return model.objects.get(pk=seed_record.object_id)

    def _upsert(
        self,
        key: str,
        model: Any,
        defaults: dict[str, Any],
        prepare_create: Any = None,
    ) -> Any:
        content_type = ContentType.objects.get_for_model(model)
        seed_record = SeedRecord.objects.select_for_update().filter(key=key).first()
        target = None
        if seed_record and seed_record.content_type_id == content_type.id:
            target = model._default_manager.filter(pk=seed_record.object_id).first()

        if target is None:
            target = model(**defaults)
            if prepare_create:
                prepare_create(target)
            try:
                target.save()
            except IntegrityError as error:
                raise CommandError(
                    f"Cannot seed {key}: an unowned record conflicts with this built-in fixture."
                ) from error
            if seed_record is None:
                SeedRecord.objects.create(
                    key=key,
                    content_type=content_type,
                    object_id=target.pk,
                )
            else:
                seed_record.content_type = content_type
                seed_record.object_id = target.pk
                seed_record.save(update_fields=["content_type", "object_id"])
            return target

        for field_name, value in defaults.items():
            setattr(target, field_name, value)
        target.save(update_fields=list(defaults))
        return target
