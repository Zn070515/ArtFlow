import io
import json
from base64 import b64encode
from decimal import Decimal, InvalidOperation
from io import BytesIO
from typing import cast
from urllib.parse import quote, urlsplit, urlunsplit
from uuid import uuid4

from accounts.decorators import admin_required, staff_required
from accounts.models import User
from accounts.services import (
    admin_verification_is_valid,
    change_user_role,
    require_current_admin,
    set_user_active,
)
from common.audit import audit_export, log_action
from common.authority import ACTIVITY_STATE, authority_write
from common.business_rules import (
    ensure_activity_unlocked,
    ensure_lifecycle_consistent,
    ensure_round_unlocked,
    ensure_same_activity,
)
from common.lifecycle import (
    runtime_approved_singers,
    runtime_is_test,
    scope_lifecycle,
    scope_runtime,
)
from common.models import AuditLog
from common.test_data import (
    clear_activity_test_data,
    get_test_data_counts,
    leave_test_mode,
    lock_activity_for_runtime_data,
)
from core.models import Activity
from core.policies import ActivityAction, ensure_activity_action_allowed
from core.services import (
    lock_activity_for_action,
    phase_choices_for_activity,
    transition_activity_phase,
    unarchive_activity,
)
from django.conf import settings
from django.contrib import messages
from django.contrib.auth.views import redirect_to_login
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Count, Prefetch, QuerySet
from django.http import Http404, HttpResponse, JsonResponse
from django.http.request import QueryDict
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST
from exports.models import ArticleTemplate
from exports.services import (
    archive_activity,
    build_archive_package,
    build_execution_package,
    build_package_zip,
    build_score_template_workbook,
    generate_persistent_document,
    render_document_bytes,
)
from farewell_show.models import Program
from files.models import MaterialCheck, MaterialRequirement, StaffNote, SubmissionFile
from files.services import (
    questionnaire_material_authority_active,
    reconcile_activity_material_checks,
    reconcile_program_material_checks,
    reconcile_singer_material_checks,
    review_material_check,
    store_submission_file,
)
from incidents.models import IncidentRecord
from openpyxl import Workbook
from openpyxl.worksheet.worksheet import Worksheet
from public_portal.models import PublicPost, ResultRelease
from public_portal.services import release_result_post, revoke_result_release
from questionnaire.projection import (
    generic_song_label,
    prime_questionnaire_answers,
    questionnaire_song_for_round,
)
from ruleset import editor as ruleset_editor
from ruleset.compiler import compile_definition
from ruleset.models import ContestRuleset, RulesetTemplate, RulesetVersion
from ruleset.schema import ENTRY_KEY, NODE_TYPE_SPEC, OutputType, parse_definition
from ruleset.services import (
    RulesetInvalidError,
    _binding_signature,
    create_ruleset_version,
    freeze_ruleset_version,
    supersede_ruleset_version,
    update_ruleset_binding,
    update_ruleset_definition_section,
)
from ruleset.templates import GOLDEN_SCHIDUI_BUILTIN_KEY
from singer_contest.judge_authority import (
    advance_performance,
    hold_judge_panel,
    hold_performance,
    issue_judge_grant,
    prepare_judge_panel,
    resume_judge_panel,
    resume_performance,
    set_judge_seat_display_label,
    submit_paper_score,
    submit_staff_proxy_score,
)
from singer_contest.models import (
    AudienceScore,
    ContestRound,
    Judge,
    JudgeSeat,
    JudgeSeatGrant,
    Performance,
    PerformanceGroup,
    PerformanceRunState,
    RoundEntry,
    RoundPanelSnapshot,
    RubricCriterion,
    ScoreRecord,
    ScoreSummary,
    ScoringRubric,
    SingerRegistration,
    StageResult,
)
from singer_contest.services import (
    IdempotencyConflictError,
    ResultClosureCode,
    RoundSetupReadiness,
    StaleScoreVersionError,
    _current_frozen_version,
    _current_resolve_status,
    _eligible_singers,
    _version_binding,
    apply_scores,
    apply_scores_if_version,
    authoritative_panel_judges,
    build_result_closure,
    confirm_stage_result,
    create_scoring_rubric,
    current_round_roster,
    ensure_audience_not_consumed_by_confirmed_stage,
    finalize_advancement,
    latest_stage_result_queryset,
    lock_round,
    maybe_resolve_checkpoints,
    missing_score_cells,
    official_stage_award_queryset,
    parse_score_workbook,
    prepare_round,
    reset_round_to_draft,
    result_closure_as_dict,
    round_roster_stage_choices,
    round_setup_readiness,
    set_manual_decision,
    set_round_groups,
    set_round_running_order,
    stage_decisions_by_blocks,
    unlock_round,
    unlock_stage_result,
    validate_roster_source_stage,
)
from voting.models import VoteOption, VoteRecord, VoteScoringRule, VoteSession
from voting.policies import formal_singer_contest_requires_ticket
from voting.services import (
    close_vote_session,
    lock_vote_session,
    open_vote_session,
    unlock_vote_session,
    vote_session_configuration_facts,
)

from staff_panel.forms import (
    CREATE_PHASE_CHOICES,
    ActivityForm,
    ContestRoundForm,
    IncidentForm,
    JudgeBoundScoreForm,
    JudgePanelAttendanceForm,
    JudgePerformanceActionForm,
    ManualDecisionForm,
    ProgramReviewForm,
    PublicPostForm,
    RapidScoreCommandForm,
    ResultReleaseForm,
    ResultReleaseRevokeForm,
    RoundGroupsForm,
    RoundRunningOrderForm,
    ScoringRubricProvisionForm,
    SingerReviewForm,
    VoteSessionForm,
)


def _with_generic_song_labels(registrations):
    """Materialize registrations with an explicit legacy/multi-round song label."""
    rows = prime_questionnaire_answers(registrations)
    for registration in rows:
        registration.song_label = generic_song_label(registration)
    return rows


def _choices(enum_class):
    return enum_class.choices


def _form_error(form):
    for field_errors in form.errors.values():
        if field_errors:
            return field_errors[0]
    return "提交的数据无效。"


def domain_error_messages(error) -> str:
    """Return the stable user-facing text for an expected domain failure."""
    error_messages = getattr(error, "messages", None)
    if error_messages:
        return "；".join(str(message) for message in error_messages)
    return str(error)


_AUTO_RESOLVE_WARNING = "该赛段无法自动核定，请人工核定。"


def _require_admin(user):
    return require_current_admin(user)


def _ensure_activity_mutable(activity):
    if activity.phase == Activity.Phase.ARCHIVED:
        raise PermissionDenied("活动已归档，为只读状态。")
    ensure_activity_unlocked(activity)


def _editable_singer_activities():
    """Return activities that can accept new singer-contest configuration."""
    return (
        Activity.objects.filter(
            activity_type=Activity.Type.SINGER_CONTEST,
            is_locked=False,
        )
        .exclude(phase=Activity.Phase.ARCHIVED)
        .order_by("-created_at")
    )


def _ensure_publication_allowed(related_activity, status):
    if (
        status == PublicPost.Status.PUBLISHED
        and related_activity is not None
        and related_activity.data_lifecycle == Activity.DataLifecycle.TEST
    ):
        raise PermissionDenied("测试活动的公开内容不能直接发布，请保存为草稿或隐藏。")


def _active_worksheet(workbook):
    worksheet = workbook.active
    if not isinstance(worksheet, Worksheet):
        raise ValueError("The active workbook sheet must be a worksheet.")
    return worksheet


@staff_required
def dashboard(request):
    return render(request, "staff_panel/dashboard.html")


@staff_required
def activity_list(request):
    activities = Activity.objects.all()
    return render(request, "staff_panel/activity_list.html", {"activities": activities})


@staff_required
def activity_workspace(request, pk):
    activity = get_object_or_404(Activity, pk=pk)
    rounds = ContestRound.objects.filter(activity=activity).annotate(
        entry_count=Count("entries", distinct=True),
        configured_judge_count=Count("round_judges", distinct=True),
    )
    vote_sessions = VoteSession.objects.filter(activity=activity)
    rubrics = ScoringRubric.objects.filter(activity=activity)
    can_configure_singer = (
        activity.activity_type == Activity.Type.SINGER_CONTEST
        and not activity.is_locked
        and activity.phase != Activity.Phase.ARCHIVED
    )
    return render(
        request,
        "staff_panel/activity_workspace.html",
        {
            "activity": activity,
            "rounds": rounds,
            "vote_sessions": vote_sessions,
            "rubrics": rubrics,
            "registration_count": SingerRegistration.objects.filter(activity=activity).count(),
            "programs": Program.objects.filter(activity=activity),
            "incident_count": IncidentRecord.objects.filter(activity=activity).count(),
            "can_configure_singer": can_configure_singer,
        },
    )


@staff_required
@require_POST
def activity_judge_entry_toggle(request, pk):
    activity = get_object_or_404(Activity, pk=pk)
    if activity.activity_type != Activity.Type.SINGER_CONTEST:
        raise PermissionDenied("只有歌手比赛支持评委彩排入口。")
    if not activity.is_test_mode or activity.phase == Activity.Phase.ARCHIVED or activity.is_locked:
        raise PermissionDenied("只有未锁定的 TEST 活动可以开放评委彩排入口。")
    activity.judge_entry_open = not activity.judge_entry_open
    with authority_write(ACTIVITY_STATE):
        activity.save(update_fields=["judge_entry_open"])
    log_action(
        request,
        AuditLog.ActionType.OTHER,
        f"Activity:{activity.pk}",
        new_value=f"judge_entry_open={activity.judge_entry_open}",
    )
    messages.success(
        request,
        "评委彩排入口已开放。" if activity.judge_entry_open else "评委彩排入口已关闭。",
    )
    return redirect("staff:activity_workspace", pk=activity.pk)


@admin_required
def activity_create(request):
    _require_admin(request.user)
    if request.method == "POST":
        form = ActivityForm(request.POST, include_lifecycle=True, include_phase=False)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/activity_form.html",
                {
                    "error": _form_error(form),
                    "activity_types": _choices(Activity.Type),
                    "phases": CREATE_PHASE_CHOICES,
                    "data": request.POST,
                    "form_data_present": True,
                },
            )
        # A new activity always starts as a draft.  The create form deliberately does
        # not expose a lifecycle selector: entering a live phase is a later, explicit
        # transition from the activity editor.
        data = dict(form.cleaned_data)
        data["phase"] = Activity.Phase.DRAFT
        activity = Activity.objects.create(**data)
        if request.FILES.get("cover_image"):
            activity.cover_image = request.FILES["cover_image"]
            activity.save(update_fields=["cover_image"])
        AuditLog.objects.create(
            operator=request.user,
            action_type=AuditLog.ActionType.OTHER,
            target=f"创建活动: {activity.title}",
        )
        return redirect("staff:activity_list")
    return render(
        request,
        "staff_panel/activity_form.html",
        {
            "activity": None,
            "activity_types": _choices(Activity.Type),
            "phases": CREATE_PHASE_CHOICES,
            "data": {},
            "form_data_present": False,
        },
    )


@admin_required
@transaction.atomic
def activity_edit(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity, pk=pk)
    if activity.phase == Activity.Phase.ARCHIVED and request.method == "GET":
        messages.info(request, "已归档活动为只读状态，请从导出中心执行解归档后再编辑。")
        return redirect("staff:export_center")
    if request.method == "POST":
        activity = lock_activity_for_action(activity)
        _ensure_activity_mutable(activity)
        form = ActivityForm(request.POST)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/activity_form.html",
                {
                    "error": _form_error(form),
                    "activity": activity,
                    "activity_types": _choices(Activity.Type),
                    "phases": phase_choices_for_activity(activity),
                    "data": request.POST,
                    "form_data_present": True,
                },
            )
        data = dict(form.cleaned_data)
        if data["activity_type"] != activity.activity_type:
            form.add_error("activity_type", "活动类型创建后不可修改。")
            return render(
                request,
                "staff_panel/activity_form.html",
                {
                    "error": _form_error(form),
                    "activity": activity,
                    "activity_types": _choices(Activity.Type),
                    "phases": phase_choices_for_activity(activity),
                    "data": request.POST,
                    "form_data_present": True,
                },
                status=400,
            )
        target_phase = data.pop("phase")
        if target_phase != activity.phase:
            activity = transition_activity_phase(activity, target_phase, actor=request.user)
        for key, value in data.items():
            setattr(activity, key, value)
        if request.FILES.get("cover_image"):
            activity.cover_image = request.FILES["cover_image"]
        try:
            activity.save()
        except ValidationError as error:
            transaction.set_rollback(True)
            form.add_error(None, domain_error_messages(error))
            return render(
                request,
                "staff_panel/activity_form.html",
                {
                    "error": _form_error(form),
                    "activity": activity,
                    "activity_types": _choices(Activity.Type),
                    "phases": phase_choices_for_activity(activity),
                    "data": request.POST,
                    "form_data_present": True,
                },
                status=400,
            )
        AuditLog.objects.create(
            operator=request.user,
            action_type=AuditLog.ActionType.OTHER,
            target=f"更新活动: {activity.title}",
        )
        return redirect("staff:activity_list")
    return render(
        request,
        "staff_panel/activity_form.html",
        {
            "activity": activity,
            "activity_types": _choices(Activity.Type),
            "phases": phase_choices_for_activity(activity),
            "data": {},
            "form_data_present": False,
        },
    )


@staff_required
def post_list(request):
    posts = PublicPost.objects.select_related("related_activity").prefetch_related(
        "result_releases__stage_result",
        Prefetch(
            "related_activity__stage_results",
            queryset=latest_stage_result_queryset().filter(
                status=StageResult.Status.CONFIRMED,
            ),
            to_attr="release_candidates",
        ),
    )
    return render(request, "staff_panel/post_list.html", {"posts": posts})


def _post_status_choices(request):
    choices = _choices(PublicPost.Status)
    if request.user.is_admin:
        return choices
    return [choice for choice in choices if choice[0] != PublicPost.Status.PUBLISHED]


@staff_required
def post_create(request):
    if request.method == "POST":
        form = PublicPostForm(request.POST)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/post_form.html",
                {
                    "error": _form_error(form),
                    "form_data": request.POST,
                    "form_data_present": True,
                    "post_types": _choices(PublicPost.PostType),
                    "statuses": _post_status_choices(request),
                    "activities": Activity.objects.all(),
                },
            )
        data = form.cleaned_data
        with transaction.atomic():
            related_activity = None
            if data["related_activity_id"]:
                related_activity = lock_activity_for_action(
                    get_object_or_404(Activity, pk=data["related_activity_id"])
                )
            _ensure_publication_allowed(related_activity, data["status"])
            publication_actor = request.user
            if data["status"] == PublicPost.Status.PUBLISHED:
                if not admin_verification_is_valid(request.session):
                    return redirect_to_login(
                        request.get_full_path(), reverse("accounts:admin_login")
                    )
                publication_actor = require_current_admin(request.user)
            post = PublicPost(
                title=data["title"],
                subtitle=data["subtitle"],
                content=data["content"],
                post_type=data["post_type"],
                status=data["status"],
                sort_order=data["sort_order"],
                is_pinned=data["is_pinned"],
                related_activity_id=data["related_activity_id"],
                created_by=publication_actor,
                updated_by=publication_actor,
            )
            if request.FILES.get("cover_image"):
                post.cover_image = request.FILES["cover_image"]
            if data["status"] == PublicPost.Status.PUBLISHED:
                post.published_at = timezone.now()
            post.save()
            log_action(
                request,
                AuditLog.ActionType.PUBLISH_POST,
                f"PublicPost:{post.pk}",
                new_value=f"status={post.status}",
            )
        return redirect("staff:post_list")
    return render(
        request,
        "staff_panel/post_form.html",
        {
            "post_types": _choices(PublicPost.PostType),
            "statuses": _post_status_choices(request),
            "activities": Activity.objects.all(),
            "form_data_present": False,
        },
    )


@staff_required
def post_preview(request, pk):
    post = get_object_or_404(PublicPost, pk=pk)
    media_items = post.media_items.filter(is_published=True)
    return render(
        request,
        "public_portal/post_detail.html",
        {"post": post, "media_items": media_items, "preview": True},
    )


@staff_required
@transaction.atomic
def post_edit(request, pk):
    post = get_object_or_404(PublicPost, pk=pk)
    if request.method == "POST":
        form = PublicPostForm(request.POST)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/post_form.html",
                {
                    "error": _form_error(form),
                    "post": post,
                    "form_data": request.POST,
                    "form_data_present": True,
                    "post_types": _choices(PublicPost.PostType),
                    "statuses": _post_status_choices(request),
                    "activities": Activity.objects.all(),
                },
            )
        data = form.cleaned_data
        old_hint_activity_id = post.related_activity_id
        new_activity_id = data["related_activity_id"]
        old_value = f"status={post.status}; title={post.title}"
        # A reparent touches up to two activities; lock both in stable ascending
        # PK order so two concurrent reparents cannot deadlock on opposite order.
        activity_ids = sorted({a for a in (old_hint_activity_id, new_activity_id) if a is not None})
        locked_by_pk = {
            a.pk: a
            for a in Activity.objects.select_for_update().filter(pk__in=activity_ids).order_by("pk")
        }
        if len(locked_by_pk) != len(activity_ids):
            raise Http404("关联的活动不存在。")
        # Lock the post too; its current parent is the authority, not the
        # pre-lock hint. If a reparent committed between our hint read and this
        # lock the row no longer matches — reject rather than chase a newly
        # revealed parent, which would break the stable Activity→PublicPost order.
        locked_post = PublicPost.objects.select_for_update().get(pk=post.pk)
        if locked_post.related_activity_id != old_hint_activity_id:
            raise PermissionDenied("页面内容已发生并发修改，请刷新后重新编辑。")
        if ResultRelease.objects.filter(
            post=locked_post, status=ResultRelease.Status.ACTIVE
        ).exists():
            raise PermissionDenied("结果已公示，编辑或移动前必须先撤销当前结果发布。")
        # Optimistic concurrency: if the client's base_version is behind the
        # current one, another staff member already saved changes. Refuse to
        # silently overwrite them; render the stale form back with an explicit
        # outdated notice so the staff can refresh and re-apply their intent.
        base_version = data.get("base_version")
        if base_version is not None and locked_post.version != base_version:
            return render(
                request,
                "staff_panel/post_form.html",
                {
                    "error": "该内容已被其他人更新，请刷新后重新编辑。",
                    "post": locked_post,
                    "form_data": request.POST,
                    "form_data_present": True,
                    "post_types": _choices(PublicPost.PostType),
                    "statuses": _post_status_choices(request),
                    "activities": Activity.objects.all(),
                },
            )
        old_locked = locked_by_pk.get(old_hint_activity_id) if old_hint_activity_id else None
        new_locked = locked_by_pk.get(new_activity_id) if new_activity_id else None
        old_status = locked_post.status
        # A move from a locked activity to an unlocked one must still be blocked;
        # checking only the new activity would let staff bypass the old lock.
        for locked_activity in (old_locked, new_locked):
            if locked_activity is not None:
                ensure_activity_unlocked(locked_activity)
        _ensure_publication_allowed(new_locked, data["status"])
        publication_actor = request.user
        if (
            data["status"] == PublicPost.Status.PUBLISHED
            or old_status == PublicPost.Status.PUBLISHED
        ):
            if not admin_verification_is_valid(request.session):
                return redirect_to_login(request.get_full_path(), reverse("accounts:admin_login"))
            publication_actor = require_current_admin(request.user)
        locked_post.title = data["title"]
        locked_post.subtitle = data["subtitle"]
        locked_post.content = data["content"]
        locked_post.post_type = data["post_type"]
        locked_post.status = data["status"]
        locked_post.sort_order = data["sort_order"]
        locked_post.is_pinned = data["is_pinned"]
        locked_post.related_activity_id = data["related_activity_id"]
        locked_post.updated_by = publication_actor
        locked_post.version += 1
        if request.FILES.get("cover_image"):
            locked_post.cover_image = request.FILES["cover_image"]
        if data["status"] == PublicPost.Status.PUBLISHED and not locked_post.published_at:
            locked_post.published_at = timezone.now()
        elif (
            data["status"] != PublicPost.Status.PUBLISHED
            and old_status == PublicPost.Status.PUBLISHED
        ):
            locked_post.published_at = None
        locked_post.save()
        log_action(
            request,
            AuditLog.ActionType.PUBLISH_POST,
            f"PublicPost:{locked_post.pk}",
            old_value=old_value,
            new_value=f"status={locked_post.status}; title={locked_post.title}",
        )
        return redirect("staff:post_list")

    return render(
        request,
        "staff_panel/post_form.html",
        {
            "post": post,
            "post_types": _choices(PublicPost.PostType),
            "statuses": _post_status_choices(request),
            "activities": Activity.objects.all(),
            "form_data_present": False,
        },
    )


def _result_release_form_context(post, form):
    stage_results: QuerySet[StageResult] = StageResult.objects.none()
    if post.related_activity_id:
        stage_results = latest_stage_result_queryset().filter(
            activity_id=post.related_activity_id,
            status=StageResult.Status.CONFIRMED,
        )
    return {
        "post": post,
        "form": form,
        "stage_results": stage_results,
    }


@staff_required
@require_POST
def result_release(request, post_id):
    post = get_object_or_404(PublicPost, pk=post_id)
    if not admin_verification_is_valid(request.session):
        return redirect_to_login(request.get_full_path(), reverse("accounts:admin_login"))
    current_admin = require_current_admin(request.user)
    form = ResultReleaseForm(request.POST)
    if not form.is_valid():
        return render(
            request,
            "staff_panel/result_release_form.html",
            _result_release_form_context(post, form),
            status=400,
        )
    try:
        stage_result = get_object_or_404(
            StageResult,
            pk=form.cleaned_data["stage_result_id"],
            activity_id=post.related_activity_id,
        )
        release_result_post(
            post,
            stage_result,
            current_admin,
            note=form.cleaned_data["note"],
        )
    except (PermissionDenied, ValidationError, IntegrityError) as error:
        form.add_error(None, domain_error_messages(error))
        return render(
            request,
            "staff_panel/result_release_form.html",
            _result_release_form_context(post, form),
            status=400,
        )
    messages.success(request, "结果已通过独立发布权威公示。")
    return redirect("staff:post_list")


@staff_required
@require_POST
def result_release_revoke(request, post_id):
    post = get_object_or_404(PublicPost, pk=post_id)
    if not admin_verification_is_valid(request.session):
        return redirect_to_login(request.get_full_path(), reverse("accounts:admin_login"))
    current_admin = require_current_admin(request.user)
    form = ResultReleaseRevokeForm(request.POST)
    if not form.is_valid():
        return render(
            request,
            "staff_panel/result_release_form.html",
            _result_release_form_context(post, form),
            status=400,
        )
    try:
        revoke_result_release(post, current_admin, note=form.cleaned_data["note"])
    except (PermissionDenied, ValidationError, IntegrityError) as error:
        form.add_error(None, domain_error_messages(error))
        return render(
            request,
            "staff_panel/result_release_form.html",
            _result_release_form_context(post, form),
            status=400,
        )
    messages.success(request, "结果发布已撤销，历史记录已保留。")
    return redirect("staff:post_list")


# --- Singer registration management ---


@staff_required
def singer_registration_list(request):
    registrations = SingerRegistration.objects.select_related("activity", "user")
    activity_id = request.GET.get("activity_id")
    if activity_id:
        registrations = registrations.filter(activity_id=activity_id)
    registrations = _with_generic_song_labels(registrations)
    return render(
        request,
        "staff_panel/singer_registration_list.html",
        {
            "registrations": registrations,
            "activities": Activity.objects.all(),
            "selected_activity_id": activity_id,
        },
    )


@staff_required
def singer_registration_detail(request, pk):
    reg = get_object_or_404(SingerRegistration.objects.select_related("activity", "user"), pk=pk)
    errors = []
    if request.method == "POST":
        is_upload = "upload_file" in request.POST
        action = ActivityAction.UPLOAD_MATERIAL if is_upload else ActivityAction.REVIEW_REGISTRATION
        ensure_activity_action_allowed(reg.activity, action)
        with transaction.atomic():
            activity = lock_activity_for_action(reg.activity, action)
            locked_reg = (
                SingerRegistration.objects.select_for_update()
                .select_related("activity", "user")
                .get(pk=reg.pk)
            )
            if locked_reg.activity_id != activity.pk:
                raise PermissionDenied("报名信息不属于当前活动。")
            if is_upload:
                f = request.FILES.get("file")
                if f:
                    try:
                        submission_file = store_submission_file(
                            owner=locked_reg,
                            uploaded_file=f,
                            purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                            uploaded_by=request.user,
                        )
                    except ValidationError as error:
                        errors.extend(error.messages)
                    else:
                        reconcile_singer_material_checks(locked_reg)
                        log_action(
                            request,
                            AuditLog.ActionType.UPLOAD_FILE,
                            f"SubmissionFile:{submission_file.pk}",
                            new_value=submission_file.original_name,
                        )
            else:
                form = SingerReviewForm(request.POST)
                if not form.is_valid():
                    errors = [_form_error(form)]
                else:
                    old_value = f"pre={locked_reg.pre_status}; live={locked_reg.live_status}"
                    locked_reg.pre_status = form.cleaned_data["pre_status"]
                    locked_reg.live_status = form.cleaned_data["live_status"]
                    note = form.cleaned_data.get("staff_note", "").strip()
                    if note:
                        StaffNote.objects.create(
                            singer_registration=locked_reg,
                            content=note,
                            created_by=request.user,
                        )
                    locked_reg.save()
                    log_action(
                        request,
                        AuditLog.ActionType.UPDATE_STATUS,
                        f"SingerRegistration:{locked_reg.pk}",
                        old_value=old_value,
                        new_value=f"pre={locked_reg.pre_status}; live={locked_reg.live_status}",
                    )
                    return redirect("staff:singer_registration_detail", pk=reg.pk)
    notes = reg.staff_notes.select_related("created_by")
    files = reg.files.all()
    checks = reg.material_checks.all()
    reg = _with_generic_song_labels([reg])[0]
    return render(
        request,
        "staff_panel/singer_registration_detail.html",
        {
            "reg": reg,
            "pre_statuses": _choices(SingerRegistration.PreStatus),
            "live_statuses": _choices(SingerRegistration.LiveStatus),
            "notes": notes,
            "files": files,
            "checks": checks,
            "check_statuses": _choices(MaterialCheck.Status),
            "file_purposes": _choices(SubmissionFile.Purpose),
            "questionnaire_material_authority": questionnaire_material_authority_active(
                reg.activity
            ),
            "errors": errors,
        },
    )


# --- Program management ---


@staff_required
def program_list(request):
    programs = Program.objects.select_related("activity", "user")
    activity_id = request.GET.get("activity_id")
    if activity_id:
        programs = programs.filter(activity_id=activity_id)
    return render(
        request,
        "staff_panel/program_list.html",
        {
            "programs": programs,
            "activities": Activity.objects.all(),
            "selected_activity_id": activity_id,
        },
    )


@staff_required
def program_detail(request, pk):
    prog = get_object_or_404(Program.objects.select_related("activity", "user"), pk=pk)
    errors = []
    if request.method == "POST":
        is_upload = "upload_file" in request.POST
        action = ActivityAction.UPLOAD_MATERIAL if is_upload else ActivityAction.REVIEW_REGISTRATION
        ensure_activity_action_allowed(prog.activity, action)
        with transaction.atomic():
            activity = lock_activity_for_action(prog.activity, action)
            locked_prog = (
                Program.objects.select_for_update()
                .select_related("activity", "user")
                .get(pk=prog.pk)
            )
            if locked_prog.activity_id != activity.pk:
                raise PermissionDenied("节目信息不属于当前活动。")
            if is_upload:
                f = request.FILES.get("file")
                if f:
                    try:
                        submission_file = store_submission_file(
                            owner=locked_prog,
                            uploaded_file=f,
                            purpose=request.POST.get("file_purpose", SubmissionFile.Purpose.OTHER),
                            uploaded_by=request.user,
                        )
                    except ValidationError as error:
                        errors.extend(error.messages)
                    else:
                        reconcile_program_material_checks(locked_prog)
                        log_action(
                            request,
                            AuditLog.ActionType.UPLOAD_FILE,
                            f"SubmissionFile:{submission_file.pk}",
                            new_value=submission_file.original_name,
                        )
            else:
                form = ProgramReviewForm(request.POST)
                if not form.is_valid():
                    errors = [_form_error(form)]
                else:
                    old_value = f"status={locked_prog.status}; sort_order={locked_prog.sort_order}"
                    locked_prog.status = form.cleaned_data["status"]
                    locked_prog.sort_order = form.cleaned_data["sort_order"]
                    note = form.cleaned_data.get("staff_note", "").strip()
                    if note:
                        StaffNote.objects.create(
                            program=locked_prog,
                            content=note,
                            created_by=request.user,
                        )
                    locked_prog.save()
                    log_action(
                        request,
                        AuditLog.ActionType.REVIEW_MATERIAL,
                        f"Program:{locked_prog.pk}",
                        old_value=old_value,
                        new_value=(
                            f"status={locked_prog.status}; sort_order={locked_prog.sort_order}"
                        ),
                    )
                    return redirect("staff:program_detail", pk=prog.pk)
    notes = prog.staff_notes.select_related("created_by")
    files = prog.files.all()
    checks = prog.material_checks.all()
    return render(
        request,
        "staff_panel/program_detail.html",
        {
            "prog": prog,
            "statuses": _choices(Program.Status),
            "program_types": _choices(Program.ProgramType),
            "notes": notes,
            "files": files,
            "checks": checks,
            "check_statuses": _choices(MaterialCheck.Status),
            "file_purposes": _choices(SubmissionFile.Purpose),
            "errors": errors,
        },
    )


@staff_required
@require_POST
def material_check_review(request):
    check = get_object_or_404(MaterialCheck, pk=request.POST.get("check_id"))
    owner = check.singer_registration or check.program
    if owner is None:
        messages.error(request, "材料检查项未关联有效报名，无法审核。")
        return redirect("staff:export_center")
    result = request.POST.get("result")
    if result == "approve":
        status = MaterialCheck.Status.APPROVED
    elif result == "supplement":
        status = MaterialCheck.Status.NEEDS_SUPPLEMENT
    else:
        messages.error(request, "无效的审核操作。")
        return _material_review_redirect(owner)
    try:
        review_material_check(
            check,
            status=status,
            note=request.POST.get("note", ""),
            actor=request.user,
        )
    except ValidationError as error:
        messages.error(request, domain_error_messages(error))
        return _material_review_redirect(owner)
    messages.success(request, f"「{check.item_name}」已审核。")
    return _material_review_redirect(owner)


def _material_review_redirect(owner):
    target = (
        "staff:singer_registration_detail"
        if getattr(owner, "student_id", None)
        else "staff:program_detail"
    )
    return redirect(target, pk=owner.pk)


@staff_required
def activity_material_requirements(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    if request.method == "POST":
        with transaction.atomic():
            locked_activity = lock_activity_for_action(activity)
            _ensure_activity_mutable(locked_activity)
            applies_to = request.POST.get("applies_to")
            item_name = request.POST.get("item_name", "").strip()
            if not item_name:
                messages.error(request, "检查项名称不能为空。")
            elif applies_to not in MaterialRequirement.AppliesTo.values:
                messages.error(request, "无效的适用范围。")
            elif (
                applies_to == MaterialRequirement.AppliesTo.SINGER
                and questionnaire_material_authority_active(locked_activity)
            ):
                messages.error(
                    request, "当前活动的选手材料由已确认问卷管理，不能再配置旧式材料项。"
                )
            else:
                MaterialRequirement.objects.update_or_create(
                    activity=locked_activity,
                    applies_to=applies_to,
                    item_name=item_name,
                    defaults={
                        "file_purpose": request.POST.get("file_purpose", "") or "",
                        "is_required": True,
                        "sort_order": request.POST.get("sort_order", 0),
                    },
                )
                reconcile_activity_material_checks(locked_activity, applies_to)
                messages.success(request, "材料检查项已保存。")
        return redirect("staff:activity_material_requirements", activity_id=activity.pk)
    requirements = MaterialRequirement.objects.filter(activity=activity)
    questionnaire_authority = questionnaire_material_authority_active(activity)
    questionnaire_version = _current_frozen_version(activity)
    return render(
        request,
        "staff_panel/material_requirements.html",
        {
            "activity": activity,
            "requirements": requirements,
            "applies_to_choices": _choices(MaterialRequirement.AppliesTo),
            "file_purposes": _choices(SubmissionFile.Purpose),
            "questionnaire_material_authority": questionnaire_authority,
            "questionnaire_version": questionnaire_version,
        },
    )


@staff_required
@require_POST
def activity_material_requirement_delete(request, activity_id, pk):
    activity = get_object_or_404(Activity, pk=activity_id)
    with transaction.atomic():
        locked_activity = lock_activity_for_action(activity)
        _ensure_activity_mutable(locked_activity)
        requirement = MaterialRequirement.objects.filter(pk=pk, activity=locked_activity).first()
        if requirement is not None:
            applies_to = requirement.applies_to
            if (
                applies_to == MaterialRequirement.AppliesTo.SINGER
                and questionnaire_material_authority_active(locked_activity)
            ):
                messages.error(request, "当前活动的选手材料由已确认问卷管理，不能删除旧式材料项。")
            else:
                requirement.delete()
                reconcile_activity_material_checks(locked_activity, applies_to)
    messages.success(request, "材料检查项已删除。")
    return redirect("staff:activity_material_requirements", activity_id=activity.pk)


# --- Excel export ---


def _export_activity(request):
    """Resolve the ?activity_id= scope, or None for a cross-activity export.

    A staff user must pick an activity; only an admin may export across all
    activities (enforced by the caller). Returns the Activity or None.
    """
    activity_id = request.GET.get("activity_id")
    if not activity_id:
        return None
    return get_object_or_404(Activity, pk=activity_id)


@staff_required
def export_registrations(request):
    activity = _export_activity(request)
    if activity is None and not request.user.is_admin:
        raise PermissionDenied("全量导出仅管理员可用；请先用活动筛选导出单个活动。")
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "报名名单"
    ws.append(
        [
            "姓名",
            "学号",
            "学院",
            "班级",
            "手机",
            "微信",
            "曲目",
            "原创",
            "赛前状态",
            "赛中状态",
            "活动",
            "提交时间",
        ]
    )
    if activity is not None:
        registration_rows = scope_runtime(
            SingerRegistration.objects.select_related("activity").filter(activity=activity),
            activity,
        )
    else:
        registration_rows = SingerRegistration.objects.select_related("activity").filter(
            is_test_data=False
        )
    rows = prime_questionnaire_answers(registration_rows)
    row_count = 0
    for r in rows:
        ws.append(
            [
                r.name,
                r.student_id,
                r.college,
                r.class_name,
                r.phone,
                r.wechat,
                generic_song_label(r),
                "是" if r.is_original else "否",
                r.get_pre_status_display(),
                r.get_live_status_display(),
                r.activity.title,
                r.created_at.strftime("%Y-%m-%d %H:%M"),
            ]
        )
        row_count += 1
    audit_export(request, activity, "registration_list", row_count=row_count)
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=registration_list.xlsx"
    wb.save(response)
    return response


@staff_required
def export_programs(request):
    activity = _export_activity(request)
    if activity is None and not request.user.is_admin:
        raise PermissionDenied("全量导出仅管理员可用；请先用活动筛选导出单个活动。")
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "节目单"
    ws.append(
        [
            "顺序",
            "节目名称",
            "类型",
            "负责人",
            "联系方式",
            "所属",
            "演员",
            "时长",
            "麦克风需求",
            "道具需求",
            "状态",
            "活动",
            "提交时间",
        ]
    )
    if activity is not None:
        rows = scope_runtime(
            Program.objects.select_related("activity").filter(activity=activity), activity
        )
    else:
        rows = Program.objects.select_related("activity").filter(is_test_data=False)
    row_count = 0
    for p in rows:
        ws.append(
            [
                p.sort_order,
                p.name,
                p.get_program_type_display(),
                p.contact_name,
                p.contact_phone,
                p.class_name,
                p.performers,
                p.estimated_duration,
                p.mic_requirements,
                p.prop_requirements,
                p.get_status_display(),
                p.activity.title,
                p.created_at.strftime("%Y-%m-%d %H:%M"),
            ]
        )
        row_count += 1
    audit_export(request, activity, "program_list", row_count=row_count)
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=program_list.xlsx"
    wb.save(response)
    return response


# --- Singer contest scoring ---


@staff_required
def round_list(request):
    rounds = list(
        ContestRound.objects.select_related("activity").annotate(
            entry_count=Count("entries", distinct=True),
            assigned_judge_count=Count("round_judges", distinct=True),
        )
    )
    activity_id = request.GET.get("activity_id") or ""
    if activity_id.isdigit():
        rounds = [
            contest_round
            for contest_round in rounds
            if str(contest_round.activity_id) == activity_id
        ]
    readiness_labels = {
        RoundSetupReadiness.WAITING_FOR_UPSTREAM_CONFIRMATION: "等待上游赛段核定",
        RoundSetupReadiness.MISSING_UPSTREAM: "缺少上游赛段结果",
        RoundSetupReadiness.STALE: "晋级名单已变化，需重新配置",
    }
    for contest_round in rounds:
        readiness = round_setup_readiness(contest_round)
        setattr(contest_round, "setup_readiness", readiness.value)
        setattr(
            contest_round,
            "setup_readiness_label",
            readiness_labels.get(readiness, ""),
        )
    return render(
        request,
        "staff_panel/round_list.html",
        {"rounds": rounds, "selected_activity_id": activity_id},
    )


@staff_required
def round_create(request):
    activities = _editable_singer_activities()
    if request.method == "POST":
        activity = get_object_or_404(activities, pk=request.POST.get("activity_id"))
        stage_choices = round_roster_stage_choices(activity)
        form = ContestRoundForm(
            request.POST,
            rubrics=ScoringRubric.objects.filter(activity=activity),
            stage_choices=stage_choices,
        )
        if not form.is_valid():
            return render(
                request,
                "staff_panel/round_form.html",
                {
                    "form": form,
                    "error": _form_error(form),
                    "activities": activities,
                    "round_types": _choices(ContestRound.RoundType),
                    "scoring_modes": _choices(ContestRound.ScoringMode),
                    "order_policies": _choices(ContestRound.OrderPolicy),
                    "tie_order_policies": _choices(ContestRound.TieOrderPolicy),
                    "roster_sources": [("", "自动判定"), *_choices(ContestRound.RosterSource)],
                    "rubrics": ScoringRubric.objects.select_related("activity").filter(
                        activity=activity
                    ),
                    "selected_activity_id": activity.pk,
                },
            )
        if form.cleaned_data["roster_source"] == ContestRound.RosterSource.STAGE:
            try:
                validate_roster_source_stage(activity, form.cleaned_data["roster_source_stage"])
            except ValidationError as error:
                form.add_error("roster_source_stage", domain_error_messages(error))
                return render(
                    request,
                    "staff_panel/round_form.html",
                    {
                        "form": form,
                        "error": _form_error(form),
                        "activities": activities,
                        "round_types": _choices(ContestRound.RoundType),
                        "scoring_modes": _choices(ContestRound.ScoringMode),
                        "order_policies": _choices(ContestRound.OrderPolicy),
                        "tie_order_policies": _choices(ContestRound.TieOrderPolicy),
                        "roster_sources": [("", "自动判定"), *_choices(ContestRound.RosterSource)],
                        "rubrics": ScoringRubric.objects.select_related("activity").filter(
                            activity=activity
                        ),
                        "selected_activity_id": activity.pk,
                    },
                )
        with transaction.atomic():
            locked_activity = lock_activity_for_action(activity)
            sequence = form.cleaned_data["sequence"]
            if (
                sequence is not None
                and ContestRound.objects.filter(
                    activity=locked_activity, sequence=sequence
                ).exists()
            ):
                form.add_error("sequence", "轮次序号已存在，请填写其他序号。")
                return render(
                    request,
                    "staff_panel/round_form.html",
                    {
                        "form": form,
                        "error": _form_error(form),
                        "activities": activities,
                        "round_types": _choices(ContestRound.RoundType),
                        "scoring_modes": _choices(ContestRound.ScoringMode),
                        "order_policies": _choices(ContestRound.OrderPolicy),
                        "tie_order_policies": _choices(ContestRound.TieOrderPolicy),
                        "roster_sources": [("", "自动判定"), *_choices(ContestRound.RosterSource)],
                        "rubrics": ScoringRubric.objects.select_related("activity").filter(
                            activity=activity
                        ),
                        "selected_activity_id": activity.pk,
                    },
                )
            try:
                with transaction.atomic():
                    create_kwargs = {
                        "activity": locked_activity,
                        "round_type": form.cleaned_data["round_type"],
                        "scoring_mode": form.cleaned_data["scoring_mode"],
                        "judge_count": form.cleaned_data["judge_count"],
                        "minimum_judge_count": form.cleaned_data["minimum_judge_count"],
                        "name": form.cleaned_data["name"],
                        "advance_count": form.cleaned_data["advance_count"],
                        "order_policy": form.cleaned_data["order_policy"],
                        "tie_order_policy": form.cleaned_data["tie_order_policy"],
                        "roster_source": form.cleaned_data["roster_source"],
                        "roster_source_stage": form.cleaned_data["roster_source_stage"],
                        "rubric": form.cleaned_data["rubric"],
                    }
                    if sequence is not None:
                        create_kwargs["sequence"] = sequence
                    contest_round = ContestRound.objects.create(**create_kwargs)
            except IntegrityError:
                form.add_error("sequence", "轮次序号已存在，请填写其他序号。")
                return render(
                    request,
                    "staff_panel/round_form.html",
                    {
                        "form": form,
                        "error": _form_error(form),
                        "activities": activities,
                        "round_types": _choices(ContestRound.RoundType),
                        "scoring_modes": _choices(ContestRound.ScoringMode),
                        "order_policies": _choices(ContestRound.OrderPolicy),
                        "tie_order_policies": _choices(ContestRound.TieOrderPolicy),
                        "roster_sources": [("", "自动判定"), *_choices(ContestRound.RosterSource)],
                        "rubrics": ScoringRubric.objects.select_related("activity").filter(
                            activity=activity
                        ),
                        "selected_activity_id": activity.pk,
                    },
                )
            log_action(
                request,
                AuditLog.ActionType.OTHER,
                f"ContestRound:{contest_round.pk}",
                new_value=contest_round.name,
            )
        return redirect("staff:round_list")

    requested_activity_id = request.GET.get("activity_id") or None
    selected_activity = (
        activities.filter(pk=requested_activity_id).first()
        if requested_activity_id is not None
        else activities.first()
    )
    if selected_activity is None:
        selected_activity = activities.first()
    selected_activity_id = str(selected_activity.pk) if selected_activity else ""
    rubrics = (
        ScoringRubric.objects.select_related("activity").filter(activity=selected_activity)
        if selected_activity is not None
        else ScoringRubric.objects.none()
    )
    form = ContestRoundForm(
        rubrics=rubrics,
        stage_choices=round_roster_stage_choices(selected_activity)
        if selected_activity is not None
        else (),
    )
    return render(
        request,
        "staff_panel/round_form.html",
        {
            "form": form,
            "activities": activities,
            "round_types": _choices(ContestRound.RoundType),
            "scoring_modes": _choices(ContestRound.ScoringMode),
            "order_policies": _choices(ContestRound.OrderPolicy),
            "tie_order_policies": _choices(ContestRound.TieOrderPolicy),
            "roster_sources": [("", "自动判定"), *_choices(ContestRound.RosterSource)],
            "rubrics": rubrics,
            "selected_activity_id": selected_activity_id,
        },
    )


@staff_required
@require_POST
def round_prepare(request, pk):
    contest_round = get_object_or_404(ContestRound.objects.select_related("activity"), pk=pk)
    try:
        ensure_activity_unlocked(contest_round.activity)
        ensure_activity_action_allowed(contest_round.activity, ActivityAction.SCORE)
        prepare_round(contest_round, request.user)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"比赛轮次准备失败：{domain_error_messages(error)}")
    return redirect("staff:round_list")


@staff_required
def round_running_order(request, pk):
    contest_round = get_object_or_404(ContestRound.objects.select_related("activity"), pk=pk)
    try:
        singers = current_round_roster(contest_round)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"暂时无法配置人工顺序：{domain_error_messages(error)}")
        return redirect("staff:round_list")
    singer_by_id = {str(singer.pk): singer for singer in singers}
    entries = list(contest_round.entries.select_related("singer").order_by("running_order", "pk"))
    initial_ids = [str(entry.singer_id) for entry in entries] or [
        str(singer.pk) for singer in singers
    ]
    display_ids = initial_ids
    if request.method == "POST":
        form = RoundRunningOrderForm(request.POST, singers=singers)
        display_ids = request.POST.getlist("singer_ids")
        if form.is_valid():
            ordered_ids = form.cleaned_data["singer_ids"]
            move_action = request.POST.get("move_action")
            if move_action is not None:
                try:
                    direction, raw_index = move_action.split(":", 1)
                    index = int(raw_index)
                except (TypeError, ValueError):
                    direction, index = "", -1
                target = index + (-1 if direction == "up" else 1)
                if direction not in {"up", "down"}:
                    target = -1
                if 0 <= index < len(ordered_ids) and 0 <= target < len(ordered_ids):
                    ordered_ids[index], ordered_ids[target] = (
                        ordered_ids[target],
                        ordered_ids[index],
                    )
                form = RoundRunningOrderForm(initial={"singer_ids": ordered_ids}, singers=singers)
                initial_ids = ordered_ids
                display_ids = ordered_ids
            else:
                try:
                    set_round_running_order(contest_round, ordered_ids, request.user)
                except (PermissionDenied, ValidationError) as error:
                    form.add_error(None, domain_error_messages(error))
                else:
                    messages.success(request, "人工出场顺序已保存。")
                    return redirect("staff:round_list")
    else:
        form = RoundRunningOrderForm(initial={"singer_ids": initial_ids}, singers=singers)
    if form.is_bound:
        ordered_ids = cast(QueryDict, form.data).getlist("singer_ids")
    else:
        ordered_ids = form.initial.get("singer_ids", display_ids)
    if hasattr(ordered_ids, "__iter__") and not isinstance(ordered_ids, str):
        ordered_ids = [str(value) for value in ordered_ids]
    order_rows = [
        {"singer": singer_by_id[singer_id], "singer_id": singer_id}
        for singer_id in ordered_ids
        if singer_id in singer_by_id
    ]
    return render(
        request,
        "staff_panel/round_running_order.html",
        {"round": contest_round, "form": form, "entries": entries, "order_rows": order_rows},
    )


@staff_required
def round_groups(request, pk):
    contest_round = get_object_or_404(ContestRound.objects.select_related("activity"), pk=pk)
    try:
        singers = current_round_roster(contest_round)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"暂时无法配置分组：{domain_error_messages(error)}")
        return redirect("staff:round_list")
    groups = list(
        PerformanceGroup.objects.filter(round=contest_round)
        .prefetch_related("performances__singer")
        .order_by("sequence", "pk")
    )
    initial_groups = [
        {"name": group.name, "singer_ids": [p.singer_id for p in group.performances.all()]}
        for group in groups
    ]
    if request.method == "POST":
        form = RoundGroupsForm(request.POST, singers=singers)
        if form.is_valid():
            try:
                set_round_groups(contest_round, form.cleaned_data["groups"], request.user)
            except (PermissionDenied, ValidationError) as error:
                form.add_error(None, domain_error_messages(error))
            else:
                messages.success(request, "分组与演出归属已保存。")
                return redirect("staff:round_list")
    else:
        form = RoundGroupsForm(singers=singers, initial_groups=initial_groups)
    group_slots = [
        {
            "number": index,
            "name": form[f"group_name_{index}"],
            "members": form[f"group_singer_ids_{index}"],
        }
        for index in range(1, RoundGroupsForm.MAX_GROUP_SLOTS + 1)
    ]
    return render(
        request,
        "staff_panel/round_groups.html",
        {"round": contest_round, "form": form, "singers": singers, "group_slots": group_slots},
    )


@staff_required
def round_score_entry(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    if contest_round.status == ContestRound.Status.DRAFT:
        return render(
            request,
            "staff_panel/round_score_entry.html",
            {"round": contest_round, "preparation_required": True},
        )

    return render(
        request,
        "staff_panel/round_score_entry.html",
        {
            "round": contest_round,
            "grid_payload": _round_grid_payload(contest_round),
            "is_locked": contest_round.is_locked
            or contest_round.status == ContestRound.Status.LOCKED,
        },
    )


def _round_grid_payload(contest_round: ContestRound) -> dict:
    singers = prime_questionnaire_answers(_eligible_singers(contest_round))
    judges = list(authoritative_panel_judges(contest_round))
    scores = {
        (s.singer_id, s.judge_id): str(s.score)
        for s in ScoreRecord.objects.filter(round=contest_round)
    }
    grid = [
        {
            "singer_id": singer.pk,
            "singer_name": singer.name,
            "song": questionnaire_song_for_round(singer, contest_round, default="未填写"),
            "cells": [
                {
                    "judge_id": judge.pk,
                    "judge_name": judge.name,
                    "score": scores.get((singer.pk, judge.pk), ""),
                }
                for judge in judges
            ],
        }
        for singer in singers
    ]
    return {
        "version": contest_round.score_version,
        "matrix_complete": not missing_score_cells(contest_round),
        "grid": grid,
        "judges": [{"id": judge.pk, "name": judge.name} for judge in judges],
    }


@staff_required
def round_scores_api(request, pk):
    """Backstage rapid-entry endpoint (M1-H).

    GET returns the current grid + ``score_version`` (the client's base version).
    POST accepts sparse ``cells`` and ``base_version``; a version mismatch is a 409
    (stale edit) so two staff never silently overwrite each other. When the save
    completes the score matrix the server re-resolves the activity's bound ruleset
    (best-effort) and reports the resulting stage status.
    """
    contest_round = get_object_or_404(ContestRound, pk=pk)

    if request.method == "GET":
        return JsonResponse({**_round_grid_payload(contest_round)})

    try:
        payload = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"detail": "请求体不是有效 JSON。"}, status=400)
    command_form = RapidScoreCommandForm(
        {"command_id": payload.get("command_id"), "base_version": payload.get("base_version")}
    )
    if not command_form.is_valid():
        return JsonResponse(
            {"detail": command_form.errors.get_json_data(), "reason_code": "INVALID_REQUEST"},
            status=400,
        )
    base_version = command_form.cleaned_data["base_version"]
    command_id = command_form.cleaned_data["command_id"]
    cells = payload.get("cells", [])
    if not isinstance(cells, list):
        return JsonResponse(
            {"detail": "cells 必须是列表。", "reason_code": "INVALID_REQUEST"}, status=400
        )

    score_values = {}
    for cell in cells:
        try:
            singer_id = int(cell["singer_id"])
            judge_id = int(cell["judge_id"])
        except (KeyError, TypeError, ValueError):
            return JsonResponse({"detail": "单元格缺少 singer_id/judge_id。"}, status=400)
        score_values[(singer_id, judge_id)] = str(cell.get("score", "")).strip()

    # ``apply_scores_if_version`` owns the Activity→Round transaction and its locks;
    # the view holds no row lock itself (M0 canonical order, §13.2 stale-guard).
    try:
        result = apply_scores_if_version(
            contest_round.pk,
            base_version,
            score_values,
            request.user,
            command_id=command_id,
        )
    except IdempotencyConflictError:
        return JsonResponse(
            {
                "detail": "同一 command_id 已用于不同的评分请求。",
                "reason_code": IdempotencyConflictError.reason_code,
                "conflict": True,
            },
            status=409,
        )
    except StaleScoreVersionError:
        contest_round.refresh_from_db()
        return JsonResponse(
            {
                **_round_grid_payload(contest_round),
                "conflict": True,
                "reason_code": "STALE_SCORE_VERSION",
            },
            status=409,
        )
    except ValidationError as error:
        return JsonResponse(
            {"detail": error.messages, "reason_code": "INVALID_REQUEST"}, status=400
        )
    except PermissionDenied:
        return JsonResponse({"detail": "权限不足。"}, status=403)

    resolved_status = None
    resolve_warning = None
    if result["matrix_complete"]:
        try:
            maybe_resolve_checkpoints(contest_round.activity, request.user)
        except (ValidationError, PermissionDenied):
            # Surface a ruleset/resolve problem to the operator instead of silently
            # dropping it (M1-INTEGRATION-CLOSE Item 7): the scores are saved but the
            # stage that could not auto-resolve must be visible, not invisible.
            resolve_warning = _AUTO_RESOLVE_WARNING
        # Report the stage's true current status (not just whether this save newly resolved
        # it): a no-op re-save of an already-READY stage must not read as "未计算".
        resolved_status = _current_resolve_status(contest_round.activity)
    response = {**result, "resolved_status": resolved_status}
    if resolve_warning:
        response["resolve_warning"] = resolve_warning
    return JsonResponse(response)


def _audience_pool(activity, version, audience_key):
    """The roster an audience score-group scores, derived from the frozen definition.

    ``audience_key`` is a binding key matching an ASSESS node's ``vote_source``; that
    node's ``source`` declares the pool: :data:`ENTRY_KEY` → the check-in pool, or the
    name of a SELECT node → the checkpoint that outputs it, bridged to the round that
    consumes that stage (its :class:`RoundEntry`). Invalid definitions and missing stage
    rosters return an empty queryset so an operator cannot accidentally score every singer.
    """
    try:
        parsed = parse_definition(version.definition)
    except (ValidationError, TypeError, ValueError):
        return SingerRegistration.objects.none()
    source = None
    for node in parsed["nodes"]:
        if node.get("vote_source") == audience_key:
            source = node.get("source")
            break
    if not source:
        return SingerRegistration.objects.none()
    if source == ENTRY_KEY:
        return runtime_approved_singers(activity).order_by("pk")
    checkpoint_key = None
    for cp in parsed["checkpoints"]:
        if cp.get("output") == source:
            checkpoint_key = cp.get("key")
            break
    if checkpoint_key:
        advance_round = (
            ContestRound.objects.filter(
                activity=activity,
                roster_source=ContestRound.RosterSource.STAGE,
                roster_source_stage=checkpoint_key,
                status__in=[
                    ContestRound.Status.PREPARED,
                    ContestRound.Status.SCORING,
                    ContestRound.Status.LOCKED,
                ],
            )
            .order_by("-sequence")
            .first()
        )
        if advance_round is not None:
            singer_ids = list(
                RoundEntry.objects.filter(round=advance_round).values_list("singer_id", flat=True)
            )
            return list(
                SingerRegistration.objects.filter(pk__in=singer_ids, activity=activity).order_by(
                    "pk"
                )
            )
    return SingerRegistration.objects.none()


def _audience_sets(activity, version):
    """Build the audience grid, scoped per stage to its real roster.

    Each binding ``audience_key → set_name`` exposes the roster the stage actually scores
    (its ``within`` pool), derived from the frozen definition via :func:`_audience_pool`.
    This prevents a staff member from entering audience scores for singers who are no
    longer in that stage (e.g. audience4 over all 15).
    """
    if version is None:
        return []
    binding = _version_binding(version)
    audience_keys = binding.get("audience_keys") or {}
    stored = {
        (s.singer_id, s.stage_key): str(s.score)
        for s in AudienceScore.objects.filter(
            activity=activity, is_test_data=runtime_is_test(activity)
        )
    }
    sets = []
    for set_key, set_name in audience_keys.items():
        singers = prime_questionnaire_answers(_audience_pool(activity, version, set_key))
        for singer in singers:
            singer.song_label = generic_song_label(singer)
        sets.append(
            {
                "set_key": set_key,
                "stage_key": set_name,
                "rows": [
                    {
                        "singer_id": singer.pk,
                        "singer_name": singer.name,
                        "song": singer.song_label,
                        "score": stored.get((singer.pk, set_name), ""),
                    }
                    for singer in singers
                ],
            }
        )
    return sets


@staff_required
def audience_score_entry(request, activity_id):
    """Minimal staff page for entering backstage audience scores."""
    activity = get_object_or_404(Activity, pk=activity_id)
    try:
        version = _current_frozen_version(activity)
    except ValidationError as error:
        messages.error(request, domain_error_messages(error))
        return redirect("staff:audience_score_entry", activity_id=activity_id)
    sets = _audience_sets(activity, version)
    return render(
        request,
        "staff_panel/audience_score_entry.html",
        {
            "activity": activity,
            "sets": sets,
            "api_url": reverse("staff:audience_scores_api", kwargs={"activity_id": activity_id}),
        },
    )


@staff_required
def audience_scores_api(request, activity_id):
    """Backstage audience-score entry (M1-INTEGRATION-2).

    GET returns the audience grid: one group per binding ``audience_keys`` entry, each
    listing the current roster for each binding plus its stored score (scale ``hundred``).
    POST accepts sparse ``cells`` as ``[{singer_id, set_key, score}]``, maps each ``set_key``
    to its ``stage_key``, upserts :class:`~singer_contest.models.AudienceScore` rows, then
    auto-resolves any now-satisfiable checkpoint.
    """
    activity = get_object_or_404(Activity, pk=activity_id)
    try:
        version = _current_frozen_version(activity)
    except ValidationError as error:
        return JsonResponse({"detail": error.messages}, status=400)
    binding = _version_binding(version) if version is not None else {}
    audience_keys = binding.get("audience_keys") or {}
    if not audience_keys:
        return JsonResponse({"detail": "该活动未绑定观众分。"}, status=400)

    if request.method == "GET":
        return JsonResponse({"sets": _audience_sets(activity, version)})

    try:
        payload = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"detail": "请求体不是有效 JSON。"}, status=400)
    cells = payload.get("cells", [])
    if not cells:
        return JsonResponse({"detail": "缺少 cells。"}, status=400)

    pool_ids_by_set = {
        set_key: {singer.pk for singer in _audience_pool(activity, version, set_key)}
        for set_key in audience_keys
    }
    rows: list[tuple[int, str, Decimal]] = []
    stage_keys: set[str] = set()
    errors: list[str] = []
    for cell in cells:
        try:
            singer_id = int(cell["singer_id"])
            score = Decimal(str(cell.get("score", "")).strip())
        except (KeyError, TypeError, ValueError, InvalidOperation):
            errors.append("单元格缺少 singer_id 或 score 不是有效数字。")
            continue
        set_key = str(cell.get("set_key", "")).strip()
        stage_key = audience_keys.get(set_key)
        if not stage_key:
            errors.append(f"未知观众分组 {set_key}。")
            continue
        if singer_id not in pool_ids_by_set[set_key]:
            errors.append(f"选手 {singer_id} 不属于观众分组 {set_key}。")
            continue
        if not 0 <= score <= 100:
            errors.append(f"选手 {singer_id} 的观众分必须在 0-100 之间。")
            continue
        # AudienceScore.score is Decimal(max_digits=8, decimal_places=2); reject more than
        # two decimal places so SQLite (stores verbatim) and Postgres (rounds to 0.01) agree.
        if score != score.quantize(Decimal("0.01")):
            errors.append(f"选手 {singer_id} 的观众分最多保留两位小数。")
            continue
        rows.append((singer_id, stage_key, score))
        stage_keys.add(stage_key)
    if errors:
        return JsonResponse({"detail": errors}, status=400)

    # Hold the Activity FOR UPDATE lock across the guard + write so the check and the rows
    # are serialized against a concurrent confirm_stage_result (which takes the same lock);
    # otherwise a confirm could commit a stage consuming this audience set between our guard
    # and our insert. The auto-resolve runs in its own transaction afterwards.
    try:
        with transaction.atomic():
            lock_activity_for_action(activity)
            for stage_key in stage_keys:
                ensure_audience_not_consumed_by_confirmed_stage(activity, stage_key)
            test_flag = runtime_is_test(activity)
            for singer_id, stage_key, score in rows:
                AudienceScore.objects.update_or_create(
                    activity=activity,
                    stage_key=stage_key,
                    singer_id=singer_id,
                    defaults={
                        "score": score,
                        "entered_by": request.user,
                        "is_test_data": test_flag,
                    },
                )
            # §14: a manually verified fallback score is a formal fact, so entering it must
            # be traceable. The audit carries the set names and row counts only — never the
            # score values, which live in the raw fact rows themselves.
            AuditLog.objects.create(
                operator=request.user,
                action_type=AuditLog.ActionType.ENTER_SCORE,
                target=f"AudienceScore:{activity.pk}",
                old_value="",
                new_value=f"sets={sorted(stage_keys)}; rows={len(rows)}",
                note="人工/外部核验观众分录入",
            )
    except ValidationError as error:
        return JsonResponse({"detail": error.messages}, status=400)
    except PermissionDenied:
        return JsonResponse({"detail": "权限不足。"}, status=403)

    # Resolve after the save transaction commits so a ruleset misconfiguration (missing bound
    # rounds, duplicate auto rulesets) reports an error without rolling back entered scores.
    # Surface it as resolve_warning (M1-INTEGRATION-CLOSE Item 7) so the operator sees that
    # a stage could not auto-resolve, instead of it disappearing silently.
    resolve_warning = None
    try:
        maybe_resolve_checkpoints(activity, request.user)
    except (ValidationError, PermissionDenied):
        resolve_warning = _AUTO_RESOLVE_WARNING

    response = {
        "saved": len(rows),
        "resolved_status": _current_resolve_status(activity),
    }
    if resolve_warning:
        response["resolve_warning"] = resolve_warning
    return JsonResponse(response)


@staff_required
def round_ranking(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    summaries = ScoreSummary.objects.filter(
        round=contest_round, singer__round_entries__round=contest_round
    ).select_related("singer")
    summary_rows = list(summaries)
    singers = prime_questionnaire_answers(summary.singer for summary in summary_rows)
    for singer in singers:
        singer.song_label = questionnaire_song_for_round(singer, contest_round, default="未填写")
    missing_cells = missing_score_cells(contest_round)
    return render(
        request,
        "staff_panel/round_ranking.html",
        {
            "round": contest_round,
            "summaries": summaries,
            "preparation_required": contest_round.status == ContestRound.Status.DRAFT,
            "has_missing": bool(missing_cells),
            "missing_cells": missing_cells,
        },
    )


@staff_required
def activity_result_board(request, activity_id):
    """List the latest StageResult per stage_key with HOLD/REVIEW/READY banners (M1-H)."""
    activity = get_object_or_404(Activity, pk=activity_id)
    stages = list(latest_stage_result_queryset(activity).order_by("stage_key", "-pk"))
    return render(
        request,
        "staff_panel/activity_result_board.html",
        {"activity": activity, "stages": stages},
    )


_RESULT_CLOSURE_LABELS = (
    {"code": ResultClosureCode.NO_CURRENT_FROZEN_RULESET.value, "label": "没有当前冻结赛制"},
    {"code": ResultClosureCode.RULESET_BINDING_INVALID.value, "label": "赛制绑定无效"},
    {"code": ResultClosureCode.RAW_FACTS_INCOMPLETE.value, "label": "原始输入未齐"},
    {"code": ResultClosureCode.RAW_FACTS_UNLOCKED.value, "label": "原始输入未锁定"},
    {"code": ResultClosureCode.RULE_REVIEW_REQUIRED.value, "label": "规则要求人工复核"},
    {
        "code": ResultClosureCode.UPSTREAM_CONFIRMATION_PENDING.value,
        "label": "上游赛段尚未核定",
    },
    {"code": ResultClosureCode.STALE_CANDIDATE.value, "label": "候选结果已过期"},
    {"code": ResultClosureCode.STAGE_CONFIRMATION_PENDING.value, "label": "赛段等待核定"},
    {
        "code": ResultClosureCode.ACTIVITY_OPERATIONALLY_LOCKED.value,
        "label": "活动已被操作锁定",
    },
    {
        "code": ResultClosureCode.ACTIVITY_PHASE_NOT_READY.value,
        "label": "活动尚未进入结果整理/公示阶段",
    },
    {
        "code": ResultClosureCode.SCHOOL_EXTERNAL_EVIDENCE_PENDING.value,
        "label": "学校外部证据待补齐",
    },
)


@staff_required
@require_GET
def activity_result_closure(request, activity_id):
    """Render the read-only event-day result closure checklist."""
    activity = get_object_or_404(Activity, pk=activity_id)
    closure = build_result_closure(activity)
    return render(
        request,
        "staff_panel/activity_result_closure.html",
        {
            "activity": activity,
            "closure": closure,
            "closure_payload": result_closure_as_dict(closure),
            "blocking_labels": _RESULT_CLOSURE_LABELS,
        },
    )


@staff_required
def stage_result_detail(request, pk):
    """Render a single stage result's decisions grouped into handcard blocks (M1-H)."""
    stage = get_object_or_404(
        latest_stage_result_queryset(),
        pk=pk,
    )
    blocks = stage_decisions_by_blocks(stage)
    decisions = [decision for block in blocks for decision in block["decisions"]]
    prime_questionnaire_answers(decision.singer for decision in decisions)
    for decision in decisions:
        decision.song_label = generic_song_label(decision.singer)
    return render(
        request,
        "staff_panel/stage_result_detail.html",
        {
            "stage": stage,
            "activity": stage.activity,
            "blocks": blocks,
            "can_unlock_stage_result": request.user.is_admin,
        },
    )


@admin_required
@require_POST
def stage_result_confirm(request, pk):
    """核定并锁定 a stage result into its final handcard state (M1-H §36-37)."""
    stage = get_object_or_404(StageResult, pk=pk)
    try:
        ensure_activity_action_allowed(stage.activity, ActivityAction.PUBLISH_RESULT)
        confirm_stage_result(stage, confirmed_by=request.user)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"赛段核定失败：{domain_error_messages(error)}")
    else:
        messages.success(request, "已核定并锁定该赛段结果，可抄主持手卡。")
    return redirect("staff:stage_result_detail", pk=pk)


@admin_required
@require_POST
def stage_result_unlock(request, pk):
    """Admin-only: unlock a confirmed stage result so its raw facts can be corrected."""
    _require_admin(request.user)
    stage = get_object_or_404(StageResult, pk=pk)
    try:
        unlock_stage_result(stage, operator=request.user, note=request.POST.get("note", "").strip())
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"赛段解锁失败：{domain_error_messages(error)}")
    else:
        messages.success(request, "已解锁该赛段结果，可修正原始数据后重新核定。")
    return redirect("staff:stage_result_detail", pk=pk)


@admin_required
@require_POST
def round_finalize_advancement(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    try:
        ensure_activity_action_allowed(contest_round.activity, ActivityAction.SCORE)
        finalize_advancement(
            contest_round, request.POST.getlist("selected_singer_ids"), request.user
        )
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"晋级名单核定失败：{domain_error_messages(error)}")
    else:
        messages.success(request, "已核定晋级名单。")
    return redirect("staff:round_ranking", pk=pk)


@staff_required
@require_POST
def round_lock(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    try:
        lock_round(contest_round, request.user)
    except ValidationError as error:
        messages.error(request, f"轮次锁定失败：{domain_error_messages(error)}")
        return redirect("staff:round_ranking", pk=pk)
    except PermissionDenied as error:
        messages.error(request, f"轮次锁定失败：{domain_error_messages(error)}")
        return redirect("staff:round_ranking", pk=pk)
    try:
        maybe_resolve_checkpoints(contest_round.activity, request.user)
    except ValidationError as error:
        messages.warning(
            request,
            f"轮次已锁定，但赛段未能自动解析：{domain_error_messages(error)}",
        )
    except PermissionDenied as error:
        messages.warning(
            request,
            f"轮次已锁定，但赛段未能自动解析：{domain_error_messages(error)}",
        )
    return redirect("staff:round_ranking", pk=pk)


@admin_required
@require_POST
def round_unlock(request, pk):
    _require_admin(request.user)
    contest_round = get_object_or_404(ContestRound, pk=pk)
    try:
        unlock_round(contest_round, request.user, note=request.POST.get("note", "").strip())
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"轮次解锁失败：{domain_error_messages(error)}")
    return redirect("staff:round_ranking", pk=pk)


@admin_required
@require_POST
def round_reset(request, pk):
    _require_admin(request.user)
    contest_round = get_object_or_404(ContestRound, pk=pk)
    reason = request.POST.get("reason", "")
    if not reason.strip():
        messages.error(request, "轮次重置失败：重置轮次必须填写原因。")
        return redirect("staff:round_list")
    try:
        reset_round_to_draft(contest_round, request.user, reason=reason)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"轮次重置失败：{domain_error_messages(error)}")
    return redirect("staff:round_list")


@staff_required
def judge_list(request):
    judges = Judge.objects.select_related("activity")
    return render(request, "staff_panel/judge_list.html", {"judges": judges})


@staff_required
def judge_create(request):
    activities = _editable_singer_activities()
    if request.method == "POST":
        activity = get_object_or_404(activities, pk=request.POST["activity_id"])
        with transaction.atomic():
            locked_activity = lock_activity_for_action(activity)
            judge = Judge.objects.create(
                activity=locked_activity,
                name=request.POST["name"],
            )
            log_action(
                request, AuditLog.ActionType.OTHER, f"Judge:{judge.pk}", new_value=judge.name
            )
        return redirect("staff:judge_list")

    return render(request, "staff_panel/judge_form.html", {"activities": activities})


def _judge_control_context(
    request,
    contest_round,
    *,
    error="",
    qr_data_uri="",
    qr_seat_id=None,
    policy_state_override="",
):
    round_judges = list(contest_round.round_judges.select_related("judge").order_by("pk"))
    panel_snapshot = (
        RoundPanelSnapshot.objects.filter(round=contest_round)
        .exclude(state=RoundPanelSnapshot.State.SUPERSEDED)
        .order_by("-version")
        .first()
    )
    panel_members = []
    panel_member_rows = []
    seat_rows = []
    if panel_snapshot is not None:
        panel_members = list(
            panel_snapshot.members.select_related("judge").filter(is_active=True).order_by("pk")
        )
        seats = {
            seat.panel_member_id: seat
            for seat in JudgeSeat.objects.filter(panel_member__in=panel_members).order_by("pk")
        }
        for member in panel_members:
            seat = seats.get(member.pk)
            seat_label = (
                seat.display_label.strip()
                if seat is not None and seat.display_label.strip()
                else member.seat_key.replace("seat-", "J")
            )
            panel_member_rows.append({"member": member, "seat_label": seat_label})
            if seat is not None:
                pending_grant = (
                    JudgeSeatGrant.objects.filter(
                        seat=seat,
                        access_grant__redeemed_at__isnull=True,
                        access_grant__revoked_at__isnull=True,
                        access_grant__expires_at__gt=timezone.now(),
                    )
                    .select_related("access_grant")
                    .first()
                )
            else:
                pending_grant = None
            seat_rows.append(
                {
                    "member": member,
                    "seat": seat,
                    "seat_label": seat_label,
                    "pending_grant": pending_grant,
                }
            )

    run_state = (
        PerformanceRunState.objects.filter(round=contest_round)
        .select_related("current_performance__singer")
        .first()
    )
    performances = list(
        Performance._base_manager.filter(round=contest_round)
        .select_related("singer")
        .order_by("sequence", "pk")
    )
    expected_judge_count = len(round_judges)
    actual_judge_count = len(panel_members)
    minimum_judge_count = (
        panel_snapshot.minimum_judge_count
        if panel_snapshot is not None
        else contest_round.minimum_judge_count or expected_judge_count
    )
    if panel_snapshot is None:
        policy_state = "PREPARE_REQUIRED"
    elif panel_snapshot.state == RoundPanelSnapshot.State.HOLD:
        policy_state = "HOLD"
    elif run_state is not None and run_state.state == PerformanceRunState.State.HOLD:
        policy_state = "HOLD"
    else:
        policy_state = "ACTIVE"
    if policy_state_override:
        policy_state = policy_state_override
    policy_state_labels = {
        "PREPARE_REQUIRED": "待准备评委组",
        "HOLD": "已暂停",
        "ACTIVE": "现场进行中",
        "INSUFFICIENT_JUDGES": "评委组人数不足，暂不可开始",
    }

    attendance_form = JudgePanelAttendanceForm(
        initial={"attending_judge_ids": [member.judge_id for member in panel_members]},
        judge_choices=[
            (round_judge.judge_id, round_judge.judge.name) for round_judge in round_judges
        ],
    )
    return {
        "round": contest_round,
        "round_judges": round_judges,
        "panel_snapshot": panel_snapshot,
        "panel_members": panel_members,
        "panel_member_rows": panel_member_rows,
        "seat_rows": seat_rows,
        "run_state": run_state,
        "performances": performances,
        "expected_judge_count": expected_judge_count,
        "actual_judge_count": actual_judge_count,
        "minimum_judge_count": minimum_judge_count,
        "policy_state": policy_state,
        "policy_state_label": policy_state_labels.get(policy_state, "现场状态待确认"),
        "attendance_form": attendance_form,
        "performance_action_form": JudgePerformanceActionForm(),
        "score_form": JudgeBoundScoreForm(
            rubric=contest_round.rubric,
            initial={
                "performance_id": run_state.current_performance_id if run_state else "",
                "context_version": run_state.context_version if run_state else 0,
            },
        ),
        "score_actions": (
            {
                "kind": "proxy",
                "title": "工作人员代录",
                "reference_label": "故障记录或来源编号",
                "command_id": f"staff-proxy-{uuid4().hex}",
            },
            {
                "kind": "paper",
                "title": "纸面评分补录",
                "reference_label": "纸面评分编号",
                "command_id": f"staff-paper-{uuid4().hex}",
            },
        ),
        "error": error,
        "qr_data_uri": qr_data_uri,
        "qr_seat_id": qr_seat_id,
    }


def _render_judge_control(request, contest_round, **kwargs):
    return render(
        request,
        "staff_panel/judge_control.html",
        _judge_control_context(request, contest_round, **kwargs),
    )


@staff_required
def judge_control(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    return _render_judge_control(request, contest_round)


@staff_required
@require_POST
@transaction.atomic
def judge_prepare(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    round_judges = list(contest_round.round_judges.select_related("judge").order_by("pk"))
    form = JudgePanelAttendanceForm(
        request.POST,
        judge_choices=[
            (round_judge.judge_id, round_judge.judge.name) for round_judge in round_judges
        ],
    )
    if not form.is_valid():
        return _render_judge_control(request, contest_round, error=_form_error(form))
    try:
        prepare_judge_panel(
            contest_round.pk,
            operator=request.user,
            attending_judge_ids=(
                None
                if contest_round.judge_count is not None
                and not request.POST.getlist("attending_judge_ids")
                else form.cleaned_data["attending_judge_ids"]
            ),
        )
    except (PermissionDenied, ValidationError) as error:
        error_message = domain_error_messages(error)
        return _render_judge_control(
            request,
            contest_round,
            error=error_message,
            policy_state_override=(
                "INSUFFICIENT_JUDGES" if "INSUFFICIENT_JUDGES" in str(error) else ""
            ),
        )
    messages.success(request, "评委组已准备，评委席位和评分上下文已冻结。")
    return redirect("staff:judge_control", pk=pk)


@staff_required
@require_POST
def judge_panel_hold(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    try:
        hold_judge_panel(
            contest_round.pk,
            operator=request.user,
            reason=request.POST.get("reason", ""),
        )
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"暂停评委组失败：{domain_error_messages(error)}")
    else:
        messages.success(request, "评委组已暂停，当前评委会话已保留；恢复后可继续评分。")
    return redirect("staff:judge_control", pk=pk)


@staff_required
@require_POST
def judge_panel_resume(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    try:
        resume_judge_panel(contest_round.pk, operator=request.user)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"恢复评委组失败：{domain_error_messages(error)}")
    else:
        messages.success(request, "评委组已恢复。")
    return redirect("staff:judge_control", pk=pk)


@staff_required
@require_POST
def judge_seat_label(request, pk, seat_id):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    try:
        seat = get_object_or_404(
            JudgeSeat,
            pk=seat_id,
            panel_member__panel_snapshot__round=contest_round,
        )
        set_judge_seat_display_label(
            seat.pk,
            operator=request.user,
            display_label=request.POST.get("display_label", ""),
        )
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"保存评委席位备注失败：{domain_error_messages(error)}")
    else:
        messages.success(request, "评委席位备注已保存。")
    return redirect("staff:judge_control", pk=pk)


@staff_required
@require_POST
def judge_performance_advance(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    form = JudgePerformanceActionForm(request.POST)
    if form.is_valid():
        try:
            advance_performance(
                contest_round.pk,
                form.cleaned_data["performance_id"],
                operator=request.user,
            )
        except (PermissionDenied, ValidationError) as error:
            messages.error(request, f"推进表演失败：{domain_error_messages(error)}")
        else:
            messages.success(request, "当前表演已切换，旧评分上下文自动失效。")
    else:
        messages.error(request, f"推进表演失败：{_form_error(form)}")
    return redirect("staff:judge_control", pk=pk)


@staff_required
@require_POST
def judge_performance_hold(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    form = JudgePerformanceActionForm(request.POST)
    if form.is_valid():
        try:
            hold_performance(
                contest_round.pk,
                operator=request.user,
                reason=form.cleaned_data["reason"],
                expected_performance_id=form.cleaned_data["performance_id"],
            )
        except (PermissionDenied, ValidationError) as error:
            messages.error(request, f"暂停表演失败：{domain_error_messages(error)}")
        else:
            messages.success(request, "当前表演已暂停。")
    else:
        messages.error(request, f"暂停表演失败：{_form_error(form)}")
    return redirect("staff:judge_control", pk=pk)


@staff_required
@require_POST
def judge_performance_resume(request, pk):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    try:
        resume_performance(contest_round.pk, operator=request.user)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"恢复表演失败：{domain_error_messages(error)}")
    else:
        messages.success(request, "当前表演已恢复。")
    return redirect("staff:judge_control", pk=pk)


@staff_required
@require_POST
def judge_seat_qr(request, pk, seat_id):
    seat = get_object_or_404(
        JudgeSeat.objects.select_related("panel_member__panel_snapshot"),
        pk=seat_id,
        panel_member__panel_snapshot__round_id=pk,
    )
    try:
        issued = issue_judge_grant(seat.pk, operator=request.user, ttl_seconds=15 * 60)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"签发评委入口失败：{domain_error_messages(error)}")
        return redirect("staff:judge_control", pk=pk)
    import qrcode

    target = f"{request.build_absolute_uri(reverse('judge:terminal'))}#{quote(issued.token)}"
    image = qrcode.make(target)
    buffer = BytesIO()
    image.save(buffer)
    qr_data_uri = f"data:image/png;base64,{b64encode(buffer.getvalue()).decode('ascii')}"
    return _render_judge_control(
        request,
        seat.panel_member.panel_snapshot.round,
        qr_data_uri=qr_data_uri,
        qr_seat_id=seat.pk,
    )


def _submit_staff_judge_score(request, pk, *, paper):
    contest_round = get_object_or_404(ContestRound, pk=pk)
    form = JudgeBoundScoreForm(request.POST, rubric=contest_round.rubric)
    if not form.is_valid():
        messages.error(request, f"评分提交失败：{_form_error(form)}")
        return redirect("staff:judge_control", pk=pk)
    values = form.cleaned_data
    if contest_round.rubric is None:
        payload = {"score": values["score"], "notes": values["notes"]}
    else:
        payload = {
            "criteria": [
                {
                    "criterion_id": criterion.pk,
                    "value": values[f"criterion_{criterion.pk}"],
                }
                for criterion in contest_round.rubric.criteria.all().order_by("sequence", "pk")
            ],
            "notes": values["notes"],
        }
    try:
        if paper:
            submit_paper_score(
                contest_round.pk,
                values["performance_id"],
                values["seat_id"],
                operator=request.user,
                command_id=values["command_id"],
                expected_context_version=values["context_version"],
                score_payload=payload,
                paper_reference=values["source_reference"],
                reason=values["reason"],
            )
        else:
            submit_staff_proxy_score(
                contest_round.pk,
                values["performance_id"],
                values["seat_id"],
                operator=request.user,
                command_id=values["command_id"],
                expected_context_version=values["context_version"],
                score_payload=payload,
                source_reference=values["source_reference"],
                reason=values["reason"],
            )
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"评分提交失败：{domain_error_messages(error)}")
    else:
        messages.success(request, "工作人员评分已记录，并绑定到当前评委席位和表演上下文。")
    return redirect("staff:judge_control", pk=pk)


@staff_required
@require_POST
def judge_score_proxy(request, pk):
    return _submit_staff_judge_score(request, pk, paper=False)


@staff_required
@require_POST
def judge_score_paper(request, pk):
    return _submit_staff_judge_score(request, pk, paper=True)


@staff_required
def rubric_create(request):
    activities = _editable_singer_activities()
    form = ScoringRubricProvisionForm(request.POST or None)
    requested_activity_id = (
        request.POST.get("activity_id") or request.GET.get("activity_id") or None
    )
    selected_activity = (
        activities.filter(pk=requested_activity_id).first()
        if requested_activity_id is not None
        else activities.first()
    )
    if selected_activity is None:
        selected_activity = activities.first()
    selected_activity_id = str(selected_activity.pk) if selected_activity else ""
    if request.method == "POST" and form.is_valid():
        activity = get_object_or_404(activities, pk=request.POST.get("activity_id"))
        try:
            create_scoring_rubric(
                activity,
                name=form.cleaned_data["name"],
                description=form.cleaned_data["description"],
                criteria=form.cleaned_data["criteria"],
                operator=request.user,
            )
        except (PermissionDenied, ValidationError) as error:
            form.add_error(None, domain_error_messages(error))
        else:
            messages.success(request, "评分标准及评分项已创建。")
            return redirect(f"{reverse('staff:round_create')}?activity_id={activity.pk}")
    criterion_slots = [
        {
            "number": index,
            "name": form[f"criterion_name_{index}"],
            "max_score": form[f"criterion_max_score_{index}"],
            "description": form[f"criterion_description_{index}"],
        }
        for index in range(1, ScoringRubricProvisionForm.MAX_CRITERION_SLOTS + 1)
    ]
    return render(
        request,
        "staff_panel/rubric_form.html",
        {
            "form": form,
            "activities": activities,
            "criterion_slots": criterion_slots,
            "selected_activity_id": selected_activity_id,
        },
    )


@staff_required
def award_list(request):
    awards = official_stage_award_queryset().select_related("activity")
    return render(request, "staff_panel/award_list.html", {"awards": awards})


# --- Vote session management ---


@staff_required
def vote_session_list(request):
    sessions = VoteSession.objects.select_related("activity")
    activity_id = request.GET.get("activity_id") or ""
    if activity_id.isdigit():
        sessions = sessions.filter(activity_id=activity_id)
    return render(
        request,
        "staff_panel/vote_session_list.html",
        {"sessions": sessions, "selected_activity_id": activity_id},
    )


@staff_required
@transaction.atomic
def vote_session_create(request):
    activities = _editable_singer_activities()
    if request.method == "POST":
        activity = get_object_or_404(activities, pk=request.POST["activity_id"])
        activity = lock_activity_for_runtime_data(activity)
        ensure_activity_unlocked(activity)
        ensure_activity_action_allowed(activity, ActivityAction.MANAGE_VOTE)
        form = VoteSessionForm(request.POST, activity=activity)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/vote_session_form.html",
                {
                    "error": _form_error(form),
                    "form": form,
                    "activities": activities,
                    "singers": _with_generic_song_labels(
                        scope_lifecycle(
                            SingerRegistration.objects.select_related("activity").filter(
                                activity=activity,
                                pre_status=SingerRegistration.PreStatus.APPROVED,
                            )
                        )
                    ),
                    "selected_activity_id": activity.pk,
                    "submitted_singer_ids": request.POST.getlist("singers"),
                    "selection_types": _choices(VoteSession.SelectionType),
                    "purposes": _choices(VoteSession.Purpose),
                    "formal_ticket_voting": formal_singer_contest_requires_ticket(activity),
                },
            )
        singer_ids = request.POST.getlist("singers")
        if len(singer_ids) != len(set(singer_ids)):
            raise PermissionDenied("Vote options cannot contain duplicate singers.")
        selected_singers = list(
            SingerRegistration.objects.filter(
                pk__in=singer_ids,
                activity=activity,
                pre_status=SingerRegistration.PreStatus.APPROVED,
            )
        )
        if len(selected_singers) != len(singer_ids):
            raise PermissionDenied("Every vote option must be an approved singer.")
        for singer in selected_singers:
            ensure_same_activity(activity, singer, label="Vote option singer")
            ensure_lifecycle_consistent(activity, singer, label="投票候选选手")
        vote_session = VoteSession.objects.create(
            activity=activity,
            name=form.cleaned_data["name"],
            passcode=(
                ""
                if formal_singer_contest_requires_ticket(activity)
                else form.cleaned_data["passcode"]
            ),
            start_time=form.cleaned_data["start_time"],
            end_time=form.cleaned_data["end_time"],
            selection_type=form.cleaned_data["selection_type"],
            max_selections=form.cleaned_data["max_selections"],
            purpose=form.cleaned_data["purpose"],
            requires_ticket=(
                True
                if formal_singer_contest_requires_ticket(activity)
                else form.cleaned_data["requires_ticket"]
            ),
            is_test_data=activity.is_test_mode,
        )
        for i, sid in enumerate(singer_ids):
            VoteOption.objects.create(
                vote_session=vote_session,
                singer_id=sid,
                sort_order=i,
                is_test_data=activity.is_test_mode,
            )
        log_action(
            request,
            AuditLog.ActionType.VOTE_MANAGE,
            f"VoteSession:{vote_session.pk}",
            new_value=vote_session.name,
        )
        return redirect("staff:vote_session_list")

    requested_activity_id = request.GET.get("activity_id") or None
    selected_activity = (
        activities.filter(pk=requested_activity_id).first()
        if requested_activity_id is not None
        else activities.first()
    )
    if selected_activity is None:
        selected_activity = activities.first()
    selected_activity_id = str(selected_activity.pk) if selected_activity else ""
    singer_queryset = SingerRegistration.objects.select_related("activity").filter(
        pre_status=SingerRegistration.PreStatus.APPROVED
    )
    if selected_activity_id.isdigit():
        singer_queryset = singer_queryset.filter(activity_id=selected_activity_id)
    else:
        singer_queryset = singer_queryset.none()
    singers = _with_generic_song_labels(scope_lifecycle(singer_queryset))
    form = VoteSessionForm(activity=selected_activity)
    return render(
        request,
        "staff_panel/vote_session_form.html",
        {
            "form": form,
            "activities": activities,
            "singers": singers,
            "selected_activity_id": selected_activity_id,
            "selection_types": _choices(VoteSession.SelectionType),
            "purposes": _choices(VoteSession.Purpose),
            "submitted_singer_ids": [],
            "formal_ticket_voting": bool(
                selected_activity and formal_singer_contest_requires_ticket(selected_activity)
            ),
        },
    )


@staff_required
def vote_session_detail(request, pk):
    vote_session = get_object_or_404(VoteSession.objects.select_related("activity"), pk=pk)
    options = list(
        vote_session.options.select_related("singer").annotate(vote_count=Count("records"))
    )
    _with_generic_song_labels(option.singer for option in options)
    total_votes = VoteRecord.objects.filter(vote_session=vote_session).count()
    _, top = _popularity_top_tie(vote_session)
    # §9: a score-component session must be reconcilable by hand — valid ballot count,
    # per-candidate votes and support rate next to the conversion mode and lock state.
    conversion = None
    conversion_rows = []
    if vote_session.purpose == VoteSession.Purpose.SCORE_COMPONENT:
        conversion = vote_session_configuration_facts(
            vote_session, test_flag=runtime_is_test(vote_session.activity)
        )
        rates = conversion["support_rate"]
        counted = conversion["candidate_votes"]
        conversion_rows = [
            {
                "singer": option.singer,
                "votes": counted.get(option.singer_id, 0),
                "rate": rates.get(str(option.singer_id)),
            }
            for option in options
        ]
    return render(
        request,
        "staff_panel/vote_session_detail.html",
        {
            "vote_session": vote_session,
            "options": options,
            "total_votes": total_votes,
            "popularity_tie": len(top) > 1,
            "conversion": conversion,
            "conversion_rows": conversion_rows,
        },
    )


@staff_required
@require_POST
def vote_session_open(request, pk):
    vote_session = get_object_or_404(VoteSession.objects.select_related("activity"), pk=pk)
    try:
        ensure_activity_action_allowed(vote_session.activity, ActivityAction.MANAGE_VOTE)
        open_vote_session(vote_session, request.user)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"投票开放失败：{domain_error_messages(error)}")
    return redirect("staff:vote_session_detail", pk=pk)


@staff_required
@require_POST
def vote_session_close(request, pk):
    vote_session = get_object_or_404(VoteSession.objects.select_related("activity"), pk=pk)
    try:
        ensure_activity_action_allowed(vote_session.activity, ActivityAction.MANAGE_VOTE)
        close_vote_session(vote_session, request.user)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"投票关闭失败：{domain_error_messages(error)}")
    return redirect("staff:vote_session_detail", pk=pk)


@staff_required
@require_POST
@transaction.atomic
def vote_session_lock(request, pk):
    vote_session = get_object_or_404(VoteSession.objects.select_related("activity"), pk=pk)
    try:
        ensure_activity_action_allowed(vote_session.activity, ActivityAction.MANAGE_VOTE)
        lock_vote_session(vote_session, request.user)
    except (ValidationError, PermissionDenied) as error:
        messages.error(request, f"投票锁定失败：{domain_error_messages(error)}")
        return redirect("staff:vote_session_detail", pk=pk)
    try:
        maybe_resolve_checkpoints(vote_session.activity, request.user)
    except (ValidationError, PermissionDenied) as error:
        messages.warning(
            request,
            "投票已锁定，但自动重算未完成：" + domain_error_messages(error),
        )
    return redirect("staff:vote_session_detail", pk=pk)


@admin_required
@require_POST
def vote_session_unlock(request, pk):
    _require_admin(request.user)
    vote_session = get_object_or_404(VoteSession, pk=pk)
    note = request.POST.get("note", "").strip()
    try:
        unlock_vote_session(vote_session, request.user, note=note)
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, f"投票解锁失败：{domain_error_messages(error)}")
    return redirect("staff:vote_session_detail", pk=pk)


@staff_required
def vote_session_export(request, pk):
    vote_session = get_object_or_404(VoteSession, pk=pk)
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "投票结果"
    ws.append(["选手", "票数"])
    from django.db.models import Count

    option_list = list(
        vote_session.options.select_related("singer").annotate(vote_count=Count("records"))
    )
    for opt in option_list:
        ws.append([opt.singer.name, getattr(opt, "vote_count", 0)])
    audit_export(request, vote_session.activity, "vote_result", row_count=len(option_list))
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = f"attachment; filename=vote_result_{vote_session.pk}.xlsx"
    wb.save(response)
    return response


def _popularity_top_tie(vote_session):
    """Return (top_vote_count, tied_top_options).

    An empty tuple result means there are no winning ballots. The tie list is
    deliberately order-independent so a database sort can never decide who wins.
    """
    leaderboard = list(
        vote_session.options.select_related("singer")
        .annotate(vote_count=Count("records"))
        .filter(vote_count__gt=0)
        .order_by("-vote_count", "sort_order", "pk")
    )
    if not leaderboard:
        return None, []
    top_count = getattr(leaderboard[0], "vote_count", 0)
    return top_count, [
        option for option in leaderboard if getattr(option, "vote_count", 0) == top_count
    ]


# --- QR code center ---


@staff_required
def qr_center(request):
    activities = Activity.objects.filter(activity_type=Activity.Type.SINGER_CONTEST)
    return render(request, "staff_panel/qr_center.html", {"activities": activities})


@staff_required
def qr_generate(request, pk):
    activity = get_object_or_404(
        Activity,
        pk=pk,
        activity_type=Activity.Type.SINGER_CONTEST,
    )
    return render(request, "staff_panel/qr_detail.html", {"activity": activity})


@staff_required
def qr_image(request, pk, kind):
    activity = get_object_or_404(
        Activity,
        pk=pk,
        activity_type=Activity.Type.SINGER_CONTEST,
    )
    stable_paths = {
        "activity": "public_portal:activity_entry",
        "apply": "public_portal:activity_apply",
        "live": "public_portal:activity_live",
        "judge": "public_portal:activity_judge",
        # Keep already printed registration sheets usable while moving them to
        # the stable activity-scoped entry. Vote/result QR kinds are retired.
        "registration": "public_portal:activity_apply",
    }
    route_name = stable_paths.get(kind)
    if route_name is not None:
        path = reverse(route_name, kwargs={"public_code": activity.public_code})
    else:
        return HttpResponse("Unknown QR code kind", status=404)

    import qrcode

    absolute_url = request.build_absolute_uri(path)
    if settings.APP_ENV == "production":
        parts = urlsplit(absolute_url)
        absolute_url = urlunsplit(("https", parts.netloc, parts.path, parts.query, parts.fragment))
    image = qrcode.make(absolute_url)
    buffer = io.BytesIO()
    image.save(buffer)
    response = HttpResponse(buffer.getvalue(), content_type="image/png")
    response["Content-Disposition"] = f'inline; filename="{kind}_{activity.pk}.png"'
    response["Cache-Control"] = "no-store"
    response["Pragma"] = "no-cache"
    return response


# --- Export center ---


@staff_required
def export_center(request):
    activities = list(Activity.objects.all())
    activity_rows = []
    for activity in activities:
        counts = get_test_data_counts(activity) if activity.is_test_mode else {}
        activity_rows.append(
            {
                "activity": activity,
                "test_data_counts": counts,
                "test_data_total": sum(counts.values()),
            }
        )
    templates = ArticleTemplate.objects.all()
    return render(
        request,
        "staff_panel/export_center.html",
        {
            "activities": activities,
            "activity_rows": activity_rows,
            "templates": templates,
        },
    )


@staff_required
def excel_material_checklist(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Material Checklist"
    ws.append(["Owner Type", "Owner", "Item", "Status"])
    row_count = 0
    for c in MaterialCheck.objects.filter(
        singer_registration__activity=activity,
        singer_registration__is_test_data=runtime_is_test(activity),
    ).select_related("singer_registration"):
        ws.append(
            [
                "singer",
                c.singer_registration.name if c.singer_registration else "",
                c.item_name,
                c.get_status_display(),
            ]
        )
        row_count += 1
    for c in MaterialCheck.objects.filter(
        program__activity=activity,
        program__is_test_data=runtime_is_test(activity),
    ).select_related("program"):
        ws.append(
            [
                "program",
                c.program.name if c.program else "",
                c.item_name,
                c.get_status_display(),
            ]
        )
        row_count += 1
    audit_export(request, activity, "material_checklist", row_count=row_count)
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=material_checklist.xlsx"
    wb.save(response)
    return response


@staff_required
def excel_score_template(request, round_id):
    contest_round = get_object_or_404(ContestRound, pk=round_id)
    singers = list(_eligible_singers(contest_round))
    wb = build_score_template_workbook(contest_round)
    audit_export(request, contest_round.activity, "score_template", row_count=len(singers))
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=score_template.xlsx"
    wb.save(response)
    return response


@staff_required
def excel_import_scores(request, round_id):
    contest_round = get_object_or_404(ContestRound, pk=round_id)
    errors = []
    if request.method == "POST" and request.FILES.get("file"):
        ensure_round_unlocked(contest_round)
        try:
            scores, errors = parse_score_workbook(request.FILES["file"], contest_round)
            if not errors:
                apply_scores(contest_round, scores, request.user, note="excel import")
                return redirect("staff:round_score_entry", pk=round_id)
        except ValidationError as error:
            errors.extend(error.messages)
        except Exception:
            errors.append("文件解析失败，请上传有效的 xlsx 评分表。")
    elif request.method == "POST":
        errors.append("请选择要导入的 xlsx 评分表。")
    return render(
        request,
        "staff_panel/excel_import.html",
        {
            "round": contest_round,
            "errors": errors,
        },
    )


# --- Word generation ---


@staff_required
@require_POST
def word_generate(request, template_id, activity_id):
    template = get_object_or_404(ArticleTemplate, pk=template_id)
    activity = get_object_or_404(Activity, pk=activity_id)
    if activity.phase == Activity.Phase.ARCHIVED:
        # Read-only preview/download for an archived activity. Archived data is
        # immutable, so this never creates a persistent asset and the official
        # archive package stays the authoritative record of it.
        content = render_document_bytes(template, activity)
        audit_export(request, activity, "word_preview")
        return _docx_response(content, template, activity.pk)
    doc_obj, content = generate_persistent_document(activity, template, request.user)
    return _docx_response(content, template, activity.pk)


def _docx_response(content: bytes, template: ArticleTemplate, activity_id: int) -> HttpResponse:
    response = HttpResponse(
        content,
        content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    response["Content-Disposition"] = (
        f"attachment; filename={template.template_type}_{activity_id}.docx"
    )
    return response


# --- Execution & archive packages ---


@staff_required
def execution_package(request, activity_id):
    activity = get_object_or_404(Activity, pk=activity_id)
    artifacts = build_execution_package(activity, request)
    response = HttpResponse(build_package_zip(artifacts), content_type="application/zip")
    response["Content-Disposition"] = f"attachment; filename=execution_{activity_id}.zip"
    audit_export(request, activity, "execution_package")
    return response


@staff_required
@require_POST
def archive_package_create(request, activity_id):
    """Produce a source-of-truth-free preview ZIP; never mutates the activity."""
    activity = get_object_or_404(Activity, pk=activity_id)
    artifacts = build_archive_package(activity)
    response = HttpResponse(build_package_zip(artifacts), content_type="application/zip")
    response["Content-Disposition"] = f"attachment; filename=archive_{activity_id}.zip"
    audit_export(request, activity, "archive_preview")
    return response


@admin_required
@require_POST
def activity_archive(request, pk):
    activity = get_object_or_404(Activity, pk=pk)
    try:
        archive_activity(activity, request.user, note=request.POST.get("note", "").strip())
    except (PermissionDenied, ValidationError) as error:
        messages.error(request, domain_error_messages(error))
        return redirect("staff:export_center")
    messages.success(request, "活动已归档并锁定。")
    return redirect("staff:export_center")


# --- Incident records ---


@staff_required
def incident_list(request):
    incidents = IncidentRecord.objects.select_related("activity", "singer", "handled_by")
    return render(request, "staff_panel/incident_list.html", {"incidents": incidents})


@staff_required
@transaction.atomic
def incident_create(request):
    activities = Activity.objects.all()
    form = IncidentForm(request.POST or None)
    if request.method == "POST":
        activity = get_object_or_404(Activity, pk=request.POST["activity_id"])
        activity = lock_activity_for_runtime_data(activity)
        ensure_activity_unlocked(activity)
        if not form.is_valid():
            return render(
                request,
                "staff_panel/incident_form.html",
                {
                    "error": _form_error(form),
                    "activities": activities,
                    "singers": _with_generic_song_labels(
                        scope_lifecycle(
                            SingerRegistration.objects.select_related("activity").filter(
                                activity=activity, pre_status=SingerRegistration.PreStatus.APPROVED
                            )
                        )
                    ),
                    "event_types": _choices(IncidentRecord.EventType),
                    "selected_activity_id": activity.pk,
                    "form": form,
                    "form_data": request.POST,
                    "selected_singer_id": request.POST.get("singer_id", ""),
                },
            )
        singer = None
        if request.POST.get("singer_id"):
            singer = get_object_or_404(SingerRegistration, pk=request.POST["singer_id"])
            ensure_same_activity(activity, singer, label="Incident singer")
            ensure_lifecycle_consistent(activity, singer, label="涉事选手")
        program = None
        if request.POST.get("program_id"):
            program = get_object_or_404(Program, pk=request.POST["program_id"])
            ensure_same_activity(activity, program, label="Incident program")
            ensure_lifecycle_consistent(activity, program, label="涉事节目")
        incident = IncidentRecord.objects.create(
            activity=activity,
            occurred_at=form.cleaned_data["occurred_at"],
            event_type=form.cleaned_data["event_type"],
            singer=singer,
            program=program,
            handled_by_id=request.user.pk,
            resolution=form.cleaned_data.get("resolution", ""),
            remark=form.cleaned_data.get("remark", ""),
            is_test=activity.is_test_mode,
        )
        log_action(
            request,
            AuditLog.ActionType.OTHER,
            f"IncidentRecord:{incident.pk}",
            new_value=incident.event_type,
        )
        return redirect("staff:incident_list")
    selected_activity_id = request.GET.get("activity_id") or ""
    singer_queryset = SingerRegistration.objects.select_related("activity").filter(
        pre_status=SingerRegistration.PreStatus.APPROVED
    )
    if selected_activity_id.isdigit():
        singer_queryset = singer_queryset.filter(activity_id=selected_activity_id)
    else:
        singer_queryset = singer_queryset.none()
    singers = _with_generic_song_labels(scope_lifecycle(singer_queryset))
    return render(
        request,
        "staff_panel/incident_form.html",
        {
            "activities": activities,
            "singers": singers,
            "event_types": _choices(IncidentRecord.EventType),
            "selected_activity_id": selected_activity_id,
            "form": form,
            "form_data": {},
            "selected_singer_id": "",
        },
    )


@staff_required
def incident_export(request):
    activity = _export_activity(request)
    if activity is None and not request.user.is_admin:
        raise PermissionDenied("全量导出仅管理员可用；请先用活动筛选导出单个活动。")
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "异常记录"
    ws.append(["活动", "时间", "类型", "选手", "处理人", "处理结果", "备注"])
    if activity is not None:
        incidents = IncidentRecord.objects.select_related(
            "activity", "singer", "handled_by"
        ).filter(activity=activity, is_test=runtime_is_test(activity))
    else:
        incidents = IncidentRecord.objects.select_related(
            "activity", "singer", "handled_by"
        ).filter(is_test=False)
    row_count = 0
    for inc in incidents:
        ws.append(
            [
                inc.activity.title,
                inc.occurred_at.strftime("%Y-%m-%d %H:%M"),
                inc.get_event_type_display(),
                inc.singer.name if inc.singer else "",
                inc.handled_by.username if inc.handled_by else "",
                inc.resolution,
                inc.remark,
            ]
        )
        row_count += 1
    audit_export(request, activity, "incident_list", row_count=row_count)
    response = HttpResponse(
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    response["Content-Disposition"] = "attachment; filename=incident_list.xlsx"
    wb.save(response)
    return response


# --- Test mode management ---


@admin_required
@require_POST
def activity_test_toggle(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity, pk=pk)
    if not activity.is_test_mode:
        raise PermissionDenied(
            "Formal activities cannot re-enter test mode. Clone the activity instead."
        )
    leave_test_mode(
        activity,
        operator=request.user,
        clear=request.POST.get("clear") == "on",
        reason=request.POST.get("reason", ""),
    )
    return redirect("staff:export_center")


@admin_required
@require_POST
def activity_clear_test_data(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity, pk=pk)
    if not activity.is_test_mode:
        raise PermissionDenied("Test data can only be cleared while the activity is in test mode.")
    counts = clear_activity_test_data(activity, operator=request.user)
    messages.success(request, f"测试数据已清理，共 {sum(counts.values())} 条记录。")
    return redirect("staff:export_center")


# --- Activity management ---


@admin_required
@require_POST
@transaction.atomic
def activity_lock(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity.objects.select_for_update(), pk=pk)
    activity.is_locked = True
    activity.locked_at = timezone.now()
    activity.locked_by = request.user
    with authority_write(ACTIVITY_STATE):
        activity.save(update_fields=["is_locked", "locked_at", "locked_by"])
    log_action(
        request, AuditLog.ActionType.RELOCK_RESULT, f"Activity:{activity.pk}", new_value="locked"
    )
    return redirect("staff:export_center")


@admin_required
@require_POST
@transaction.atomic
def activity_unlock(request, pk):
    _require_admin(request.user)
    note = request.POST.get("note", "").strip()
    activity = get_object_or_404(Activity.objects.select_for_update(), pk=pk)
    if activity.phase == Activity.Phase.ARCHIVED:
        raise PermissionDenied("活动已归档，请使用解归档功能。")
    activity.is_locked = False
    activity.locked_at = None
    activity.locked_by = None
    with authority_write(ACTIVITY_STATE):
        activity.save(update_fields=["is_locked", "locked_at", "locked_by"])
    log_action(
        request,
        AuditLog.ActionType.UNLOCK_RESULT,
        f"Activity:{activity.pk}",
        old_value="locked",
        new_value="unlocked",
        note=note,
    )
    return redirect("staff:export_center")


@admin_required
@require_POST
def activity_unarchive(request, pk):
    _require_admin(request.user)
    activity = get_object_or_404(Activity, pk=pk)
    unarchive_activity(activity, actor=request.user, note=request.POST.get("note", "").strip())
    messages.success(request, "活动已解归档并恢复到结果公示阶段。")
    return redirect("staff:export_center")


@admin_required
@require_POST
@transaction.atomic
def activity_clone(request, pk):
    _require_admin(request.user)
    original = get_object_or_404(Activity, pk=pk)
    new_activity = Activity.objects.create(
        title=f"{original.title}（副本）",
        subtitle=original.subtitle,
        activity_type=original.activity_type,
        phase=Activity.Phase.DRAFT,
        description=original.description,
        is_test_mode=True,
    )
    for req in MaterialRequirement.objects.filter(activity=original):
        MaterialRequirement.objects.create(
            activity=new_activity,
            applies_to=req.applies_to,
            item_name=req.item_name,
            file_purpose=req.file_purpose,
            is_required=req.is_required,
            sort_order=req.sort_order,
        )
    for judge in Judge.objects.filter(activity=original):
        Judge.objects.create(
            activity=new_activity,
            name=judge.name,
            is_active=judge.is_active,
        )
    rubric_map: dict[int | None, ScoringRubric] = {}
    for rubric in ScoringRubric.objects.filter(activity=original):
        new_rubric = ScoringRubric.objects.create(
            activity=new_activity,
            name=rubric.name,
            description=rubric.description,
            sequence=rubric.sequence,
            is_test_data=runtime_is_test(new_activity),
        )
        for criterion in rubric.criteria.all():
            RubricCriterion.objects.create(
                rubric=new_rubric,
                name=criterion.name,
                max_score=criterion.max_score,
                sequence=criterion.sequence,
                description=criterion.description,
                is_test_data=runtime_is_test(new_activity),
            )
        rubric_map[rubric.pk] = new_rubric
    for contest_round in ContestRound.objects.filter(activity=original):
        ContestRound.objects.create(
            activity=new_activity,
            round_type=contest_round.round_type,
            scoring_mode=contest_round.scoring_mode,
            minimum_judge_count=contest_round.minimum_judge_count,
            judge_count=contest_round.judge_count,
            name=contest_round.name,
            advance_count=contest_round.advance_count,
            sequence=contest_round.sequence,
            order_policy=contest_round.order_policy,
            tie_order_policy=contest_round.tie_order_policy,
            roster_source=contest_round.roster_source,
            roster_source_stage=contest_round.roster_source_stage,
            rubric=rubric_map.get(contest_round.rubric_id),
            is_locked=False,
        )
    # Vote sessions are runtime state (passcode, start/end window, open/locked),
    # not reusable template config. Cloning would copy a stale passcode and time
    # window into the new activity, so staff create sessions fresh per activity.
    log_action(
        request,
        AuditLog.ActionType.OTHER,
        f"Activity:{original.pk}",
        new_value=f"cloned_to={new_activity.pk}",
    )
    return redirect("staff:export_center")


# --- Audit log ---


@staff_required
def audit_log_list(request):
    logs = AuditLog.objects.select_related("operator")[:200]
    return render(request, "staff_panel/audit_log_list.html", {"logs": logs})


# --- User & role administration ---


@admin_required
def user_list(request):
    _require_admin(request.user)
    users = User.objects.order_by("-date_joined", "username")
    return render(request, "staff_panel/user_list.html", {"users": users})


@admin_required
@require_POST
def user_role_update(request, pk):
    _require_admin(request.user)
    target = get_object_or_404(User, pk=pk)
    try:
        updated = change_user_role(
            target=target, new_role=request.POST.get("new_role", ""), actor=request.user
        )
    except (ValidationError, PermissionDenied) as error:
        messages.error(request, domain_error_messages(error))
    else:
        messages.success(
            request, f"已将 {updated.username} 的角色改为 {updated.get_role_display()}。"
        )
    return redirect("staff:user_list")


@admin_required
@require_POST
def user_set_active(request, pk):
    _require_admin(request.user)
    target = get_object_or_404(User, pk=pk)
    is_active = request.POST.get("active") == "1"
    try:
        updated = set_user_active(target=target, is_active=is_active, actor=request.user)
    except (ValidationError, PermissionDenied) as error:
        messages.error(request, domain_error_messages(error))
    else:
        messages.success(
            request, f"已{'启用' if updated.is_active else '停用'}账号 {updated.username}。"
        )
    return redirect("staff:user_list")


@staff_required
def ruleset_template_list(request):
    # Show the catalog with explicit capability status. Only production templates
    # expose cloning; experimental/unsupported entries must never look production-ready.
    templates = RulesetTemplate.objects.all()
    activities = _editable_singer_activities()
    return render(
        request,
        "staff_panel/ruleset_template_list.html",
        {"templates": templates, "total": templates.count(), "activities": activities},
    )


@staff_required
def ruleset_template_detail(request, pk):
    template = get_object_or_404(RulesetTemplate, pk=pk)
    nodes = parse_definition(template.definition)["nodes"] if template.definition else []
    activities = _editable_singer_activities()
    return render(
        request,
        "staff_panel/ruleset_template_detail.html",
        {"template": template, "nodes": nodes, "activities": activities},
    )


def _starter_definition():
    """Minimal forward-only graph a blank ruleset starts from."""
    return json.dumps(
        {
            "schema_version": 1,
            "nodes": [
                {"key": "assess_r1", "type": "ASSESS", "source": ENTRY_KEY, "round": "r1"},
                {"key": "rank1", "type": "RANK", "source": "assess_r1", "descending": True},
                {"key": "top10", "type": "SELECT", "source": "rank1", "count": 10},
            ],
        },
        ensure_ascii=False,
    )


def _unique_key(nodes, base):
    used = {n["key"] for n in nodes}
    candidate = base
    counter = 1
    while candidate in used:
        candidate = f"{base}_{counter}"
        counter += 1
    return candidate


def _last_node_of(output_types, nodes):
    for node in reversed(nodes):
        if NODE_TYPE_SPEC[node["type"]].output_type in output_types:
            return node["key"]
    return ENTRY_KEY


def _default_node(new_type, nodes):
    best_spec = NODE_TYPE_SPEC.get(new_type)
    if best_spec is None:
        raise ValueError(f"unknown node type {new_type!r}")
    node = {"key": _unique_key(nodes, new_type.lower()), "type": new_type}
    expects = (best_spec.expects or {}).get("source")
    if expects and OutputType.SCOREMAP in expects:
        source = _last_node_of({OutputType.SCOREMAP, OutputType.RANKED_ROSTER}, nodes)
    elif expects and OutputType.RANKED_ROSTER in expects:
        source = _last_node_of({OutputType.RANKED_ROSTER}, nodes)
    else:
        source = ENTRY_KEY
    for field in best_spec.required:
        if field == "source":
            node["source"] = source
        elif field == "count":
            node["count"] = 1
        elif field == "sources":
            node["sources"] = [ENTRY_KEY]
        elif field == "by":
            node["by"] = "组1"
        elif field == "aggregate":
            src = _last_node_of({OutputType.SCOREMAP}, nodes)
            node["aggregate"] = {
                "type": "weighted_sum",
                "components": [{"source": src or ENTRY_KEY, "weight": 1.0}],
            }
        elif field == "branches":
            node["branches"] = [{"when": "default", "into": ENTRY_KEY}]
        elif field == "minuend":
            node["minuend"] = ENTRY_KEY
        elif field == "subtrahend":
            node["subtrahend"] = ENTRY_KEY
        elif field == "quota":
            node["quota"] = 1
        elif field == "groups":
            node["groups"] = 1
        elif field == "pairing_policy":
            node["pairing_policy"] = "ADJACENT"
        elif field == "from":
            node["from"] = ENTRY_KEY
        elif field == "into":
            node["into"] = _last_node_of({OutputType.GROUP_MAP}, nodes)
        elif field == "award":
            node["award"] = "默认奖项"
        elif field == "decision_source":
            node["decision_source"] = "manual_recorded_result"
    if new_type == "ASSESS":
        node["round"] = f"r{len(nodes) + 1}"
    return node


def _humanize_ruleset_editor_error(error):
    """Turn schema/compiler vocabulary into an operator-facing message."""
    raw = " ".join(getattr(error, "messages", None) or [str(error)])
    import re

    forward = re.search(
        r"Node (?P<node>[^:]+): source '(?P<source>[^']+)' is not defined before this node",
        raw,
    )
    if forward:
        return (
            f"节点“{forward.group('node')}”依赖“{forward.group('source')}”，"
            "当前顺序或引用不合法，请先调整依赖关系。"
        )
    missing = re.search(
        r"Node (?P<node>[^:]+): source '(?P<source>[^']+)' is not defined",
        raw,
    )
    if missing:
        return (
            f"节点“{missing.group('node')}”仍引用不存在的“{missing.group('source')}”，"
            "请先修改引用或删除下游节点。"
        )
    if "unknown node type" in raw:
        return "这个节点类型暂不支持，请从可用节点类型中选择。"
    if "duplicate node key" in raw:
        return "节点键不能重复，请修改节点名称。"
    if raw.startswith(("当前", "该", "找不到", "这个节点")):
        return raw
    return "赛制定义未通过校验，请检查节点顺序、来源和字段填写。"


_NODE_TYPE_LABELS = {
    "ROSTER": "报名名单",
    "ASSESS": "评分",
    "RANK": "排名",
    "SELECT": "选出名额",
    "PARTITION": "分组",
    "MERGE": "合并名单",
    "SUBTRACT": "排除名单",
    "PAIR": "配对",
    "DUEL": "对决",
    "AGGREGATE": "综合成绩",
    "MANUAL_SELECT": "人工选择",
    "FILL_TO_QUOTA": "补足名额",
    "AWARD": "奖项",
}


def _try_parse_nodes(nodes):
    try:
        parse_definition({"nodes": nodes})
    except ValidationError:
        return False
    return True


def _move_node_to_nearest_valid_slot(nodes, key, delta):
    index = next((i for i, n in enumerate(nodes) if n["key"] == key), None)
    if index is None:
        return list(nodes), index
    targets = range(index - 1, -1, -1) if delta < 0 else range(index + 1, len(nodes))
    for target in targets:
        candidate = list(nodes)
        item = candidate.pop(index)
        candidate.insert(target, item)
        if _try_parse_nodes(candidate):
            return candidate, target
    return list(nodes), index


def _edit_nodes(post, nodes) -> list[dict]:
    """Return the new ``nodes`` list for one editor action.

    Only the node list: the caller patches ``definition.nodes`` as a single section via
    ``update_ruleset_definition_section``, so the root's other sections survive. Returning
    a rebuilt ``{"schema_version", "nodes"}`` document here is what used to delete
    ``checkpoints`` / ``context`` / ``questionnaire`` on every save.
    """
    action = post.get("action")
    if action == "add":
        new_type = post.get("new_type", "ASSESS")
        if new_type == "BRANCH":
            raise ValueError("这个节点类型暂不支持，请从可用节点类型中选择。")
        candidate = nodes + [_default_node(new_type, nodes)]
        if not _try_parse_nodes(candidate):
            raise ValueError(f"当前节点结构不能新增“{new_type}”，请先补齐可用的上游节点。")
        nodes = candidate
    elif action == "delete":
        key = post.get("key")
        candidate = [n for n in nodes if n["key"] != key]
        if len(candidate) == len(nodes):
            raise ValueError("找不到要删除的节点，请刷新页面后重试。")
        if not _try_parse_nodes(candidate):
            raise ValueError("该节点仍被其他节点引用，请先调整下游节点的来源。")
        nodes = candidate
    elif action == "move_up":
        original_index = next((i for i, n in enumerate(nodes) if n["key"] == post.get("key")), None)
        nodes, target = _move_node_to_nearest_valid_slot(nodes, post.get("key"), -1)
        if target == original_index:
            raise ValueError("该节点不能再向上移动：它的上游依赖必须保持在前面。")
    elif action == "move_down":
        original_index = next((i for i, n in enumerate(nodes) if n["key"] == post.get("key")), None)
        nodes, target = _move_node_to_nearest_valid_slot(nodes, post.get("key"), +1)
        if target == original_index:
            raise ValueError("该节点不能再向下移动：后续节点仍依赖它。")
    elif action == "save":
        return ruleset_editor.nodes_from_form(post)
    else:
        raise ValueError(f"unknown action {action!r}")
    return nodes


def _source_options(nodes, index, field, current=None):
    spec = NODE_TYPE_SPEC.get(nodes[index].get("type"))
    expected = (spec.expects or {}).get(field) if spec else None
    options = []
    if expected and OutputType.ROSTER in expected:
        options.append(ENTRY_KEY)
    for prior in nodes[:index]:
        prior_spec = NODE_TYPE_SPEC.get(prior.get("type"))
        if prior_spec is None or (expected and prior_spec.output_type not in expected):
            continue
        options.append(prior["key"])
    if current and current not in options:
        options.append(current)
    return options


def _display_options(options, labels=None, nodes=None):
    labels = labels or {}
    node_labels = {
        node.get("key"): (
            f"{node.get('key')}（{_NODE_TYPE_LABELS.get(node.get('type'), node.get('type'))}）"
        )
        for node in (nodes or [])
        if node.get("key")
    }
    return [
        {
            "value": option,
            "label": labels.get(option)
            or ("报名选手" if option == ENTRY_KEY else node_labels.get(option, option)),
        }
        for option in options
    ]


def _node_field_entries(node, index, nodes, *, binding_options=None):
    """Render data-driven edit fields for one node card (select/text/checkbox/json/aggregate)."""
    labels = ruleset_editor.field_labels()
    help_text = ruleset_editor.field_help()
    binding_options = binding_options or {}
    allowed = ruleset_editor.field_allowed()
    option_labels = ruleset_editor.field_option_labels()
    spec = NODE_TYPE_SPEC.get(node.get("type"))
    fields: list[dict] = []
    if spec is None:
        return fields
    reference_fields = {
        "source",
        "within",
        "minuend",
        "subtrahend",
        "from",
        "into",
        "by",
        "ranking_source",
        "tie_break_source",
    }
    for field in list(spec.required) + list(spec.optional):
        label = labels.get(field, field)
        base = f"node_{index}_{field}"
        value = node.get(field)
        if field == "aggregate":
            aggregate = node.get("aggregate", {})
            fields.append(
                {
                    "kind": "aggregate",
                    "label": label,
                    "help": help_text.get(field, ""),
                    "index": index,
                    "aggregate_type": aggregate.get("type", "weighted_sum"),
                    "components": [
                        {
                            "source": c.get("source", ""),
                            "weight": c.get("weight", 1.0),
                            "options": _source_options(
                                nodes, index, "aggregate.components[].source", c.get("source")
                            ),
                            "display_options": _display_options(
                                _source_options(
                                    nodes, index, "aggregate.components[].source", c.get("source")
                                ),
                                nodes=nodes,
                            ),
                        }
                        for c in aggregate.get("components", [])
                    ],
                }
            )
        elif field == "within":
            fields.append(
                {
                    "kind": "select",
                    "label": label,
                    "help": help_text.get(field, ""),
                    "name": base,
                    "value": value or "",
                    "options": _source_options(nodes, index, field, value),
                    "display_options": _display_options(
                        _source_options(nodes, index, field, value), nodes=nodes
                    ),
                }
            )
        elif field in ("branches", "conversion"):
            fields.append(
                {
                    "kind": "json",
                    "label": label,
                    "help": help_text.get(field, ""),
                    "name": f"{base}_json",
                    "value": json.dumps(value, ensure_ascii=False) if value else "",
                }
            )
        elif isinstance(value, bool):
            fields.append(
                {
                    "kind": "checkbox",
                    "label": label,
                    "help": help_text.get(field, ""),
                    "name": base,
                    "value": value,
                }
            )
        elif field in binding_options:
            options = list(binding_options[field])
            if value and value not in options:
                options.append(value)
            fields.append(
                {
                    "kind": "select",
                    "label": label,
                    "help": help_text.get(field, ""),
                    "name": base,
                    "value": value if value is not None else "",
                    "options": options,
                    "display_options": _display_options(
                        options,
                        labels={option: f"{option}（活动绑定）" for option in options},
                    ),
                }
            )
        elif allowed.get(field):
            fields.append(
                {
                    "kind": "select",
                    "label": label,
                    "help": help_text.get(field, ""),
                    "name": base,
                    "value": value if value is not None else "",
                    "options": allowed[field],
                    "display_options": _display_options(
                        allowed[field], labels=option_labels.get(field)
                    ),
                }
            )
        elif field in reference_fields and (field != "by" or field in (spec.expects or {})):
            fields.append(
                {
                    "kind": "select",
                    "label": label,
                    "help": help_text.get(field, ""),
                    "name": base,
                    "value": value or "",
                    "options": _source_options(nodes, index, field, value),
                    "display_options": _display_options(
                        _source_options(nodes, index, field, value), nodes=nodes
                    ),
                }
            )
        elif field == "sources":
            fields.append(
                {
                    "kind": "multi_select",
                    "label": label,
                    "help": help_text.get(field, ""),
                    "name": base,
                    "value": value or [],
                    "options": _source_options(nodes, index, field),
                    "display_options": _display_options(
                        _source_options(nodes, index, field), nodes=nodes
                    ),
                }
            )
        else:
            fields.append(
                {
                    "kind": "text",
                    "label": label,
                    "help": help_text.get(field, ""),
                    "name": base,
                    "value": value if value is not None else "",
                }
            )
    return fields


def _build_card(node, index, nodes, *, binding_options=None):
    sources = ruleset_editor.available_sources(nodes, index)
    _up_preview, up_target = _move_node_to_nearest_valid_slot(nodes, node["key"], -1)
    _down_preview, down_target = _move_node_to_nearest_valid_slot(nodes, node["key"], 1)
    delete_candidate = [item for item in nodes if item["key"] != node["key"]]
    delete_allowed = len(delete_candidate) != len(nodes) and _try_parse_nodes(delete_candidate)
    return {
        "node": node,
        "index": index,
        "type": node.get("type"),
        "type_label": _NODE_TYPE_LABELS.get(node.get("type"), node.get("type")),
        "sources": sources,
        "fields": _node_field_entries(node, index, nodes, binding_options=binding_options),
        "can_move_up": up_target != index,
        "can_move_down": down_target != index,
        "can_delete": delete_allowed,
        "move_up_reason": "该节点的上游依赖必须保持在前面。",
        "move_down_reason": "后续节点仍依赖该节点。",
        "delete_reason": "该节点仍被其他节点引用。",
    }


def _node_type_options(nodes):
    options = []
    for node_type in sorted(t for t in NODE_TYPE_SPEC if t != "BRANCH"):
        try:
            candidate = nodes + [_default_node(node_type, nodes)]
            if not _try_parse_nodes(candidate):
                raise ValueError
        except (ValueError, ValidationError):
            options.append(
                {
                    "value": node_type,
                    "label": _NODE_TYPE_LABELS.get(node_type, node_type),
                    "enabled": False,
                    "reason": "当前缺少可用的上游节点。",
                }
            )
        else:
            options.append(
                {
                    "value": node_type,
                    "label": _NODE_TYPE_LABELS.get(node_type, node_type),
                    "enabled": True,
                    "reason": "",
                }
            )
    return options


@staff_required
@transaction.atomic
def contest_ruleset_create(request):
    activities = _editable_singer_activities()
    if request.method == "POST":
        # Keep the candidate lookup broad enough for the authoritative lock check to
        # produce its stable 403 response.  Filtering ``is_locked=False`` here would
        # turn a valid mutation attempt against a locked activity into a misleading
        # 404 before ``lock_activity_for_action`` can re-validate it.
        activity = get_object_or_404(
            Activity,
            pk=request.POST.get("activity"),
            activity_type=Activity.Type.SINGER_CONTEST,
        )
        activity = lock_activity_for_action(activity)
        name = (request.POST.get("name") or "").strip()
        if not name:
            messages.error(request, "请填写赛制名称。")
            return redirect("staff:contest_ruleset_create")
        template = None
        template_pk = request.POST.get("template")
        if template_pk:
            template = get_object_or_404(RulesetTemplate, pk=template_pk)
        # One activity owns one ContestRuleset (versions live on RulesetVersion). If a
        # ruleset already exists, reuse it instead of creating a competing authority that
        # would make recompute_activity_result's single-authority assumption ambiguous.
        existing = ContestRuleset.objects.filter(activity=activity).first()
        if existing is not None:
            if template is not None:
                existing.source_template = template
                existing.name = name or existing.name
                existing.is_test_data = runtime_is_test(activity)
                existing.save()
                version = create_ruleset_version(
                    existing, definition=template.definition, created_by=request.user
                )
                messages.success(request, f"已将「{template.name}」克隆到该活动，进入编辑。")
            else:
                # Reuse the single authority: edit the latest DRAFT, or supersede a frozen
                # current into a fresh editing DRAFT — never redirect into a frozen version.
                draft = (
                    existing.versions.filter(status=RulesetVersion.Status.DRAFT)
                    .order_by("-version")
                    .first()
                )
                if draft is None:
                    frozen = (
                        existing.versions.filter(status=RulesetVersion.Status.FROZEN)
                        .order_by("-version")
                        .first()
                    )
                    version = (
                        supersede_ruleset_version(frozen, created_by=request.user)
                        if frozen is not None
                        else create_ruleset_version(
                            existing,
                            definition=_starter_definition(),
                            created_by=request.user,
                        )
                    )
                else:
                    version = draft
                messages.info(request, "该活动已有赛制，进入现有赛制编辑。")
            return redirect("staff:ruleset_edit", pk=version.pk)
        definition = template.definition if template else _starter_definition()
        ruleset = ContestRuleset.objects.create(
            activity=activity,
            name=name,
            source_template=template,
            is_test_data=runtime_is_test(activity),
            created_by=request.user,
        )
        version = create_ruleset_version(ruleset, definition=definition, created_by=request.user)
        messages.success(request, "赛制已创建，进入编辑。")
        return redirect("staff:ruleset_edit", pk=version.pk)
    templates = RulesetTemplate.objects.filter(
        capability_status=RulesetTemplate.CapabilityStatus.PRODUCTION
    ).order_by("name")
    requested_activity_id = request.GET.get("activity") or None
    selected_activity = (
        activities.filter(pk=requested_activity_id).first()
        if requested_activity_id is not None
        else activities.first()
    )
    if selected_activity is None:
        selected_activity = activities.first()
    selected_activity_id = str(selected_activity.pk) if selected_activity else ""
    return render(
        request,
        "staff_panel/ruleset_create.html",
        {
            "activities": activities,
            "templates": templates,
            "selected_activity_id": selected_activity_id,
        },
    )


@staff_required
@transaction.atomic
def ruleset_edit(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    if version.status == RulesetVersion.Status.FROZEN:
        raise PermissionDenied("已冻结赛制版本不可编辑。")
    if request.method == "POST":
        try:
            current = ruleset_editor.definition_nodes(version.definition)
            nodes = _edit_nodes(request.POST, current)
            parse_definition({"nodes": nodes})
        except (ValueError, ValidationError) as exc:
            messages.error(request, f"保存失败：{_humanize_ruleset_editor_error(exc)}")
            return redirect("staff:ruleset_edit", pk=pk)
        try:
            update_ruleset_definition_section(
                version,
                section="nodes",
                value=nodes,
                operator=request.user,
                base_content_hash=request.POST.get("base_content_hash") or None,
            )
        except ValidationError as exc:
            messages.error(request, domain_error_messages(exc))
            return redirect("staff:ruleset_edit", pk=pk)
        messages.success(request, "赛制已保存。")
        return redirect("staff:ruleset_edit", pk=pk)
    try:
        nodes = parse_definition(version.definition)["nodes"]
    except ValidationError:
        nodes = []
    ruleset = version.ruleset
    binding_options = {
        "round": list((ruleset.round_keys or {}).keys()),
        "vote_source": list((ruleset.vote_keys or {}).keys()),
    }
    cards = [
        _build_card(node, i, nodes, binding_options=binding_options) for i, node in enumerate(nodes)
    ]
    current_round_keys = {str(node.get("round")) for node in nodes if node.get("round")}
    current_vote_keys = {str(node.get("vote_source")) for node in nodes if node.get("vote_source")}
    current_group_keys = {
        str(node.get("by")) for node in nodes if node.get("type") == "PARTITION" and node.get("by")
    }
    round_candidates = list(
        ContestRound.objects.filter(activity=ruleset.activity).order_by("sequence", "pk")
    )
    vote_candidates = list(
        VoteSession.objects.filter(activity=ruleset.activity).order_by("-created_at", "pk")
    )
    scoring_rule_candidates = list(
        VoteScoringRule.objects.filter(vote_session__activity=ruleset.activity)
        .select_related("vote_session")
        .order_by("vote_session_id")
    )
    round_binding = ruleset.round_keys or {}
    vote_binding = ruleset.vote_keys or {}
    scoring_binding = ruleset.vote_scoring_rule_keys or {}
    group_binding = ruleset.group_keys or {}
    binding_maps = {
        "rounds": [
            {
                "key": key,
                "value": str(round_binding.get(key, "")),
                "options": [
                    (
                        str(item.pk),
                        (
                            f"{item.name or item.get_round_type_display()}"
                            f"（第 {item.sequence or '-'} 轮）"
                        ),
                    )
                    for item in round_candidates
                ],
            }
            for key in sorted(current_round_keys | set(round_binding))
        ],
        "votes": [
            {
                "key": key,
                "value": str(vote_binding.get(key, "")),
                "options": [(str(item.pk), item.name) for item in vote_candidates],
            }
            for key in sorted(current_vote_keys | set(vote_binding))
        ],
        "scoring_rules": [
            {
                "key": key,
                "value": str(scoring_binding.get(key, "")),
                "options": [
                    (str(item.pk), f"{item.vote_session.name}（{item.get_mode_display()}）")
                    for item in scoring_rule_candidates
                    if item.vote_session_id == vote_binding.get(key)
                    or str(item.vote_session_id) == str(vote_binding.get(key, ""))
                ],
            }
            for key in sorted(set(scoring_binding) | current_vote_keys)
        ],
        "groups": [
            {
                "key": key,
                "value": str(group_binding.get(key, "")),
                "options": [
                    (
                        str(item.pk),
                        f"{item.name or item.get_round_type_display()}（分组来源）",
                    )
                    for item in round_candidates
                ],
            }
            for key in sorted(current_group_keys | set(group_binding))
        ],
    }
    return render(
        request,
        "staff_panel/ruleset_editor.html",
        {
            "version": version,
            "ruleset": ruleset,
            "cards": cards,
            # §28 capability matrix: BRANCH remains unsupported at runtime and is
            # not offered. Other types are shown but disabled when their default
            # configuration cannot be valid with the current upstream graph.
            "node_types": sorted(t for t in NODE_TYPE_SPEC if t != "BRANCH"),
            "node_type_options": _node_type_options(nodes),
            "binding_json": {
                "round_keys": json.dumps(ruleset.round_keys or {}, ensure_ascii=False),
                "vote_keys": json.dumps(ruleset.vote_keys or {}, ensure_ascii=False),
                "vote_scoring_rule_keys": json.dumps(
                    ruleset.vote_scoring_rule_keys or {}, ensure_ascii=False
                ),
                "group_keys": json.dumps(ruleset.group_keys or {}, ensure_ascii=False),
                "audience_keys": json.dumps(ruleset.audience_keys or {}, ensure_ascii=False),
                "announcement_blocks": json.dumps(
                    ruleset.announcement_blocks or [], ensure_ascii=False
                ),
                "announcement_blocks_by_checkpoint": json.dumps(
                    ruleset.announcement_blocks_by_checkpoint or {},
                    ensure_ascii=False,
                ),
            },
            "binding_signature": _binding_signature(ruleset),
            "binding_maps": binding_maps,
        },
    )


@staff_required
@require_POST
@transaction.atomic
def ruleset_bind(request, pk):
    """Save the activity-owning binding (stage/round/vote/group/announcement) to a ruleset (§32).

    Only the editable input surface (ContestRuleset) is written here; the snapshot runs at
    freeze time via ``_snapshot_binding``.
    """
    version = get_object_or_404(RulesetVersion, pk=pk)
    lock_activity_for_action(version.ruleset.activity)

    def _parse_json(name, empty):
        raw = (request.POST.get(name) or "").strip()
        if not raw:
            return empty
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise ValidationError(f"{name} 不是合法 JSON。")

    def _parse_pairs(key_name, value_name, legacy_name, empty):
        keys = request.POST.getlist(key_name)
        values = request.POST.getlist(value_name)
        if not keys and not values:
            return _parse_json(legacy_name, empty)
        if len(keys) != len(values):
            raise ValidationError(f"{key_name} 与 {value_name} 数量不一致。")
        return {
            key.strip(): value
            for key, value in zip(keys, values, strict=True)
            if key.strip() and value
        }

    try:
        update_ruleset_binding(
            version.ruleset,
            binding={
                "stage_key": request.POST.get("stage_key"),
                "round_keys": _parse_pairs(
                    "round_binding_key", "round_binding_value", "round_keys", {}
                ),
                "vote_keys": _parse_pairs(
                    "vote_binding_key", "vote_binding_value", "vote_keys", {}
                ),
                "vote_scoring_rule_keys": _parse_pairs(
                    "scoring_binding_key", "scoring_binding_value", "vote_scoring_rule_keys", {}
                ),
                "group_keys": _parse_pairs(
                    "group_binding_key", "group_binding_value", "group_keys", {}
                ),
                "audience_keys": _parse_json("audience_keys", {}),
                "announcement_blocks": _parse_json("announcement_blocks", []),
                "announcement_blocks_by_checkpoint": _parse_json(
                    "announcement_blocks_by_checkpoint", {}
                ),
            },
            operator=request.user,
            base_binding=request.POST.get("base_binding") or None,
        )
    except ValidationError as exc:
        messages.error(request, domain_error_messages(exc))
        return redirect("staff:ruleset_edit", pk=pk)
    except PermissionDenied as exc:
        messages.error(request, domain_error_messages(exc))
        return redirect("staff:ruleset_edit", pk=pk)
    messages.success(request, "生产绑定已保存。")
    return redirect("staff:ruleset_edit", pk=pk)


@admin_required
def manual_decision(request, pk):
    version = get_object_or_404(RulesetVersion.objects.select_related("ruleset__activity"), pk=pk)
    form = ManualDecisionForm(
        request.POST or None, version=version, activity=version.ruleset.activity
    )
    if request.method == "POST" and form.is_valid():
        try:
            set_manual_decision(
                version,
                manual_key=form.cleaned_data["manual_key"],
                group=form.cleaned_data["group"],
                chosen=form.cleaned_data["chosen"],
                created_by=request.user,
            )
        except (PermissionDenied, ValidationError) as error:
            form.add_error(None, domain_error_messages(error))
        else:
            messages.success(request, "人工晋级选择已保存。")
            return redirect("staff:ruleset_edit", pk=pk)
    return render(
        request,
        "staff_panel/manual_decision_form.html",
        {"form": form, "version": version, "activity": version.ruleset.activity},
    )


@staff_required
def ruleset_validate(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    report, plan = compile_definition(version.definition)
    return render(
        request,
        "staff_panel/ruleset_validate.html",
        {
            "version": version,
            "passes": report.passes(),
            "issues": [i.to_dict() for i in report.issues],
            "counts": report.counts(),
            "summary": plan.summary if plan else None,
        },
    )


@staff_required
def ruleset_preview(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    report, plan, result = ruleset_editor.preview_definition(version.definition)
    return render(
        request,
        "staff_panel/ruleset_preview.html",
        {
            "version": version,
            "passes": report.passes(),
            "issues": [i.to_dict() for i in report.issues],
            "summary": plan.summary if plan else None,
            "status": result.status.value if result else "—",
            "node_values": result.node_values if result else None,
            "decisions": [d.to_dict() for d in result.decisions][:20] if result else None,
        },
    )


@admin_required
@require_POST
def ruleset_freeze(request, pk):
    version = get_object_or_404(RulesetVersion, pk=pk)
    try:
        freeze_ruleset_version(version, request.user)
    except PermissionDenied as exc:
        messages.error(request, domain_error_messages(exc))
    except RulesetInvalidError as exc:
        errors = [i.message for i in exc.report.issues if i.severity.value == "error"]
        messages.error(request, "赛制排版未通过校验：" + ("；".join(errors) or "存在 ERROR"))
    except ValidationError as exc:
        messages.error(request, domain_error_messages(exc))
    else:
        messages.success(request, "赛制已冻结。")
    return redirect("staff:ruleset_edit", pk=pk)


@staff_required
@require_POST
@transaction.atomic
def ruleset_clone_from_template(request, template_pk):
    template = get_object_or_404(
        RulesetTemplate,
        pk=template_pk,
        capability_status=RulesetTemplate.CapabilityStatus.PRODUCTION,
    )
    activity = get_object_or_404(
        Activity,
        pk=request.POST.get("activity"),
        activity_type=Activity.Type.SINGER_CONTEST,
    )
    activity = lock_activity_for_action(activity)
    _ensure_activity_mutable(activity)
    name = (request.POST.get("name") or "").strip() or template.name
    ruleset, _created = ContestRuleset.objects.get_or_create(
        activity=activity,
        defaults={
            "name": name,
            "source_template": template,
            "is_test_data": runtime_is_test(activity),
            "created_by": request.user,
        },
    )
    ruleset.name = name
    ruleset.source_template = template
    ruleset.is_test_data = runtime_is_test(activity)
    ruleset.save()
    version = create_ruleset_version(
        ruleset, definition=template.definition, created_by=request.user
    )
    messages.success(request, f"已从「{template.name}」克隆到活动，进入编辑。")
    return redirect("staff:ruleset_edit", pk=version.pk)


@staff_required
@require_POST
def ruleset_clone_last_year(request):
    # Identity, not display name: the 2025 historical template is found by its stable
    # builtin_key so a future rename can never break "clone last year" (§11.2).
    template = get_object_or_404(RulesetTemplate, builtin_key=GOLDEN_SCHIDUI_BUILTIN_KEY)
    return ruleset_clone_from_template(request, template.pk)
