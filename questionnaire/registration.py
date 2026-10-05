"""P3 — the registration lifecycle the frozen questionnaire drives.

Opening the form creates the draft; filling it is incremental; submitting is one atomic
server-side act. Three properties are structural rather than checked in prose:

- **The submission context is built, not accepted.** ``build_submission_context`` reads
  the activity phase and the round entries. There is no parameter through which a browser
  could assert its own phase or its own qualification, so "forged context" is not a case
  that has to be defended — it is a case that cannot be expressed.
- **A bound answer lives on the registration.** Writing one never also stores it in the
  response, so there is exactly one copy of a bound value and nothing to reconcile.
- **The answers a participant posts are matched against the questionnaire.** A key the
  plan does not define is not a field; it is dropped, not written.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal, InvalidOperation
from enum import StrEnum

from common.lifecycle import runtime_is_test
from core.models import Activity
from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from files.services import reconcile_questionnaire_material_checks
from singer_contest.models import (
    Group,
    GroupMembership,
    GroupStage,
    RoundEntry,
    SingerRegistration,
)

from .compiler import QuestionnairePlan, compile_questionnaire
from .models import QuestionnaireResponse
from .runtime import missing_required
from .services import (
    get_or_create_group_response,
    get_or_create_response,
    mark_submitted,
    save_draft_answers,
)


def questionnaire_plan(version) -> QuestionnairePlan:
    """The compiled questionnaire of a frozen version (``None`` when it has none)."""
    root = json.loads(version.definition)
    raw = root.get("questionnaire")
    if raw is None:
        raise ValidationError("当前赛制尚未配置报名问卷。")
    return compile_questionnaire(raw)


def build_submission_context(*, version, registration) -> dict:
    """The server-side facts a condition may read, keyed the way the DSL names them.

    Qualification is read from the round entries the participant actually has, in the
    binding's round-key namespace (``r1``, ``r2``, ...) — never from the round's display
    name, which a rename would silently break.
    """
    activity = version.ruleset.activity
    round_keys = (version.binding or {}).get("round_keys") or {}
    entered = set(RoundEntry.objects.filter(singer=registration).values_list("round_id", flat=True))
    context: dict = {"activity.phase": activity.phase}
    for key, round_id in round_keys.items():
        context[f"qualified.{key}"] = round_id in entered
    return context


def build_group_submission_context(*, version, group: Group) -> dict:
    """Build condition context from the confirmed Group aggregate."""
    activity = version.ruleset.activity
    return {
        "activity.phase": activity.phase,
        "group.stage": group.stage.stage_key,
        "group.order": group.group_order,
        "group.member_count": group.memberships.filter(is_current=True).count(),
    }


def current_answer_files(registration) -> dict:
    """The current file answering each question, keyed by question key.

    Read through the same ``is_current`` flag the storage service maintains, so "what does
    this participant's second-round accompaniment hold right now" has one answer.
    """
    from files.models import SubmissionFile

    owner_filter = (
        {"group": registration}
        if isinstance(registration, Group)
        else {"singer_registration": registration}
    )
    return {
        row.question_key: row
        for row in SubmissionFile.objects.filter(**owner_filter, is_current=True).exclude(
            question_key=""
        )
    }


def current_group_answer_files(group: Group) -> dict:
    return current_answer_files(group)


# Phases in which the questionnaire is closed to ordinary editing: only a question staff
# explicitly sent back may be touched.
SUPPLEMENT_PHASES = frozenset({Activity.Phase.REGISTRATION_CLOSED, Activity.Phase.REVIEWING})


def writable_question_keys(*, activity, registration, plan) -> frozenset[str] | None:
    """Which questions this participant may write right now, or ``None`` for all of them.

    Authority is the activity's phase plus the staff supplement grants — **never** the
    response's status. A response marked SUBMITTED records that the participant completed
    a formal submission; it does not mean they forfeited the right to correct their own
    details while registration is still open. Making the status the gate locked people out
    of their own form the moment they submitted, until the deadline — while leaving file
    uploads open, which was neither the intended rule nor a coherent one.
    """
    from files.models import MaterialCheck

    if activity.is_locked:
        return frozenset()
    if activity.phase == Activity.Phase.REGISTRATION_OPEN:
        return None
    if activity.phase not in SUPPLEMENT_PHASES:
        return frozenset()
    return frozenset(
        MaterialCheck.objects.filter(
            singer_registration=registration,
            status=MaterialCheck.Status.NEEDS_SUPPLEMENT,
        )
        .exclude(question_key="")
        .values_list("question_key", flat=True)
    )


class GroupMaterialWriteScope(StrEnum):
    """What a Group Chorus group may write right now."""

    ALL = "all"
    SUPPLEMENT_ONLY = "supplement_only"
    NONE = "none"


def group_material_write_scope(group: Group) -> GroupMaterialWriteScope:
    """The single authority for Group Chorus material writability.

    A group's material window is **not** the activity's registration phase. Grouping
    happens after registration closes — the roster comes from an external draw taken once
    the contest is already running — so a first submission under the participant rule
    would be impossible (the phase is past ``REGISTRATION_OPEN``) or would need a fake
    per-question supplement grant. The window lives on the stage instead
    (:attr:`GroupStage.material_status`), so material can open during rehearsal or even
    live, and closing it is a deliberate staff act rather than a side effect of advancing
    the activity.
    """
    stage = group.stage
    if stage.activity.is_locked or stage.status == GroupStage.Status.DRAFT or not group.is_active:
        return GroupMaterialWriteScope.NONE
    status = stage.material_status
    if status == GroupStage.MaterialStatus.OPEN:
        return GroupMaterialWriteScope.ALL
    if status == GroupStage.MaterialStatus.SUPPLEMENT_ONLY:
        return GroupMaterialWriteScope.SUPPLEMENT_ONLY
    return GroupMaterialWriteScope.NONE


def writable_group_question_keys(*, group: Group, plan) -> frozenset[str] | None:
    """Group equivalent of participant writable-question authority.

    Returns ``None`` for "any question", an explicit key set for "only these", and an
    empty set for "nothing". The stage's material window decides; the activity phase is
    deliberately not consulted (see :func:`group_material_write_scope`).
    """
    from files.models import MaterialCheck

    scope = group_material_write_scope(group)
    if scope is GroupMaterialWriteScope.ALL:
        return None
    if scope is GroupMaterialWriteScope.NONE:
        return frozenset()
    return frozenset(
        MaterialCheck.objects.filter(group=group, status=MaterialCheck.Status.NEEDS_SUPPLEMENT)
        .exclude(question_key="")
        .values_list("question_key", flat=True)
    )


def _require_group_member(group: Group, actor):
    actor_pk = getattr(actor, "pk", None)
    current_actor = get_user_model().objects.filter(pk=actor_pk, is_active=True).first()
    if (
        current_actor is None
        or not GroupMembership.objects.filter(
            group=group, is_current=True, singer__user_id=current_actor.pk
        ).exists()
    ):
        raise PermissionDenied("只有当前分组合唱成员可以维护本组材料。")
    return current_actor


def _keys_of(plan: QuestionnairePlan, answers) -> set[str]:
    return {key for key in (answers or {}) if plan.question(key) is not None}


def normalize_answer(question: dict, raw):
    """Normalize one client value and enforce the frozen question's value domain."""
    if raw is None:
        return None
    qtype = question["type"]
    validation = question.get("validation") or {}
    if qtype in {"text", "textarea"}:
        if not isinstance(raw, str):
            raise ValidationError(f"题目 {question['key']} 必须是文本。")
        value = raw
        if "min_length" in validation and value and len(value) < validation["min_length"]:
            raise ValidationError(f"题目 {question['key']} 少于最小长度。")
        if "max_length" in validation and len(value) > validation["max_length"]:
            raise ValidationError(f"题目 {question['key']} 超过最大长度。")
        if (
            value
            and validation.get("format") == "phone_cn"
            and not re.fullmatch(r"1[3-9]\d{9}", value)
        ):
            raise ValidationError(f"题目 {question['key']} 不是有效的中国大陆手机号。")
        if value and validation.get("format") == "email" and not _is_simple_email(value):
            raise ValidationError(f"题目 {question['key']} 不是有效的邮箱地址。")
        return value
    if qtype == "number":
        if isinstance(raw, bool) or (not isinstance(raw, (int, float, str))):
            raise ValidationError(f"题目 {question['key']} 必须是数字。")
        if isinstance(raw, str) and not raw.strip():
            return ""
        try:
            decimal_value = Decimal(str(raw).strip())
        except (InvalidOperation, ValueError):
            raise ValidationError(f"题目 {question['key']} 必须是数字。") from None
        if not decimal_value.is_finite():
            raise ValidationError(f"题目 {question['key']} 必须是有限数字。")
        if "min" in validation and decimal_value < Decimal(str(validation["min"])):
            raise ValidationError(f"题目 {question['key']} 小于允许的最小值。")
        if "max" in validation and decimal_value > Decimal(str(validation["max"])):
            raise ValidationError(f"题目 {question['key']} 大于允许的最大值。")
        return (
            int(decimal_value)
            if decimal_value == decimal_value.to_integral_value()
            else float(decimal_value)
        )
    if qtype == "boolean":
        if not isinstance(raw, bool):
            raise ValidationError(f"题目 {question['key']} 必须是布尔值。")
        return raw
    if qtype in {"single_choice", "select"}:
        if not isinstance(raw, str):
            raise ValidationError(f"题目 {question['key']} 必须是单个选项。")
        allowed = {option["value"] for option in question.get("options", [])}
        if raw and raw not in allowed:
            raise ValidationError(f"题目 {question['key']} 的选项无效。")
        return raw
    if qtype == "multiple_choice":
        if not isinstance(raw, list) or any(not isinstance(value, str) for value in raw):
            raise ValidationError(f"题目 {question['key']} 必须是选项列表。")
        if len(raw) != len(set(raw)):
            raise ValidationError(f"题目 {question['key']} 的选项不能重复。")
        allowed = {option["value"] for option in question.get("options", [])}
        if any(value not in allowed for value in raw):
            raise ValidationError(f"题目 {question['key']} 包含无效选项。")
        if "min_selections" in validation and len(raw) < validation["min_selections"]:
            raise ValidationError(f"题目 {question['key']} 选择项过少。")
        if "max_selections" in validation and len(raw) > validation["max_selections"]:
            raise ValidationError(f"题目 {question['key']} 选择项过多。")
        return list(raw)
    if qtype == "file":
        raise ValidationError(f"题目 {question['key']} 必须通过文件上传入口提交。")
    raise ValidationError(f"题目 {question['key']} 类型不受支持。")


def _is_simple_email(value: str) -> bool:
    """Validate the supported email shape without a backtracking regex."""
    local, separator, domain = value.partition("@")
    if not separator or value.count("@") != 1 or not local or not domain:
        return False
    if any(character.isspace() for character in value):
        return False
    labels = domain.split(".")
    return "." in domain and all(labels)


def normalize_answers(plan: QuestionnairePlan, answers) -> dict:
    """Normalize all known participant answers; unknown keys are ignored."""
    if not isinstance(answers, dict):
        raise ValidationError("answers 必须是对象。")
    normalized = {}
    for key, raw in answers.items():
        question = plan.question(key)
        if question is None:
            continue
        normalized[key] = normalize_answer(question, raw)
    return normalized


def split_answers(plan: QuestionnairePlan, answers) -> tuple[dict, dict]:
    """Split posted answers into ``(binding -> value, question key -> value)``.

    A key the questionnaire does not define is dropped rather than stored: the plan is the
    only authority on what a question is, so an unknown key is not an answer.
    """
    bound: dict = {}
    unbound: dict = {}
    for key, value in (answers or {}).items():
        question = plan.question(key)
        if question is None:
            continue
        binding = question.get("binding")
        if binding:
            bound[binding] = value
        else:
            unbound[key] = value
    return bound, unbound


def _apply_bound_fields(registration: SingerRegistration, bound: dict) -> list[str]:
    """Put bound values on the in-memory registration; return the fields touched."""
    fields = []
    for binding, value in bound.items():
        _, _, field = binding.partition(".")
        setattr(registration, field, value)
        fields.append(field)
    return fields


def _save_bound_fields(registration: SingerRegistration, fields: list[str]) -> None:
    if not fields:
        return
    try:
        with transaction.atomic():
            registration.save(update_fields=[*fields, "updated_at"])
    except IntegrityError:
        raise ValidationError("报名信息与已有选手冲突，请检查学号等唯一字段。") from None


@transaction.atomic
def get_or_create_draft_registration(*, version, user):
    """The participant's draft registration and response for this version.

    Idempotent by construction: the first open creates both, every later open re-reads
    them. The draft is deliberately not APPROVED — it is not in the roster, and nothing
    downstream counts it.
    """
    activity = version.ruleset.activity
    plan = questionnaire_plan(version)
    registration, _created = SingerRegistration.objects.get_or_create(
        activity=activity,
        user=user,
        defaults={"is_test_data": runtime_is_test(activity)},
    )
    first_open = not QuestionnaireResponse.objects.filter(
        singer_registration=registration, ruleset_version=version, questionnaire_key=plan.key
    ).exists()
    response = get_or_create_response(
        registration=registration,
        ruleset_version=version,
        questionnaire_key=plan.key,
        schema_hash=plan.schema_hash,
        is_test_data=registration.is_test_data,
    )
    if first_open:
        # One material check per question, so staff have something to review and to send
        # back. Done on the first open rather than on every request: this is called from
        # every autosave, upload and page view.
        reconcile_questionnaire_material_checks(
            registration=registration, version=version, plan=plan
        )
    return registration, response


@transaction.atomic
def save_draft(*, version, registration, answers, schema_hash: str = "") -> QuestionnaireResponse:
    """Persist one autosave: bound answers onto the registration, the rest into the response."""
    plan = questionnaire_plan(version)
    if schema_hash and schema_hash != plan.schema_hash:
        raise ValidationError("问卷已更新，请刷新后重试。")
    answers = normalize_answers(plan, answers)
    activity = version.ruleset.activity
    response = get_or_create_response(
        registration=registration,
        ruleset_version=version,
        questionnaire_key=plan.key,
        schema_hash=plan.schema_hash,
        is_test_data=registration.is_test_data,
    )
    writable = writable_question_keys(activity=activity, registration=registration, plan=plan)
    if writable is not None:
        rejected = sorted(_keys_of(plan, answers) - writable)
        if rejected:
            # A crafted POST is judged here, not by whether the form rendered the field as
            # disabled: hiding an input has never been the authorization boundary.
            raise ValidationError(f"以下题目当前不可修改：{'、'.join(rejected)}。")
    bound, unbound = split_answers(plan, answers)
    _save_bound_fields(registration, _apply_bound_fields(registration, bound))
    return save_draft_answers(response, answers=unbound, schema_hash=schema_hash)


@transaction.atomic
def submit_registration(
    *,
    version,
    registration,
    answers,
    due_rounds: frozenset[str] | set[str] = frozenset(),
    files=None,
    expected_schema_hash: str = "",
) -> QuestionnaireResponse:
    """Re-check and finish a registration.

    Everything is recomputed from the frozen version rather than trusted from the draft:
    the response is re-read, the context is rebuilt from server facts, conditions are
    re-evaluated, and the due-now required questions are proven answered before anything
    is marked submitted. A refusal leaves the draft exactly as it was, so a participant
    who is missing one field loses nothing else.

    Submitting more than once is ordinary, not exceptional: while registration is open a
    participant who has submitted may correct their details and submit again, and the
    first ``submitted_at`` is kept as the statement-of-record timestamp.
    """
    if version.status != type(version).Status.FROZEN or not version.is_current:
        raise ValidationError("只有当前已冻结赛制可以提交报名。")
    plan = questionnaire_plan(version)
    if expected_schema_hash and expected_schema_hash != plan.schema_hash:
        raise ValidationError("问卷已更新，请刷新后重试。")
    answers = normalize_answers(plan, answers)
    response = get_or_create_response(
        registration=registration,
        ruleset_version=version,
        questionnaire_key=plan.key,
        schema_hash=plan.schema_hash,
        is_test_data=registration.is_test_data,
    )
    writable = writable_question_keys(
        activity=version.ruleset.activity, registration=registration, plan=plan
    )
    if writable is not None and not writable:
        raise ValidationError("当前阶段不可提交报名资料。")
    if writable is not None:
        # A submission carries the whole form, so a locked question is normally just the
        # browser re-sending what it already had — it is *dropped* rather than refused, or
        # a participant sent back to fix one question could not re-submit at all.
        answers = {key: value for key, value in (answers or {}).items() if key in writable}

    bound, unbound = split_answers(plan, answers)
    merged = dict(response.answers or {})
    merged.update(unbound)
    context = build_submission_context(version=version, registration=registration)
    # Apply bound values in memory only, so the completeness check sees the whole form
    # while a refusal still leaves the stored draft exactly as it was.
    fields = _apply_bound_fields(registration, bound)
    missing = missing_required(
        plan,
        registration=registration,
        answers=merged,
        context=context,
        due_rounds=due_rounds,
        files=current_answer_files(registration) if files is None else files,
    )
    if missing:
        raise ValidationError(f"以下必填项尚未填写：{'、'.join(missing)}。")

    _save_bound_fields(registration, fields)
    saved = save_draft_answers(response, answers=unbound, schema_hash=plan.schema_hash)
    # Re-reconcile on the way in: a question added by a successor, or a file that arrived
    # since the last reconcile, has to be visible to staff from the moment it is submitted.
    reconcile_questionnaire_material_checks(registration=registration, version=version, plan=plan)
    registration.pre_status = SingerRegistration.PreStatus.SUBMITTED
    registration.save(update_fields=["pre_status", "updated_at"])
    submitted = mark_submitted(saved)
    from common.models import AuditLog

    AuditLog.objects.create(
        operator=registration.user,
        action_type=AuditLog.ActionType.UPDATE_REGISTRATION,
        target=f"QuestionnaireResponse:{submitted.pk}",
        old_value=saved.status,
        new_value=submitted.status,
        note="questionnaire_submit",
    )
    return submitted


@transaction.atomic
def save_group_draft(*, version, group: Group, answers, actor, schema_hash: str = ""):
    _require_group_member(group, actor)
    plan = questionnaire_plan(version)
    if plan.subject != "group":
        raise ValidationError("当前赛制问卷不是分组合唱组问卷。")
    if schema_hash and schema_hash != plan.schema_hash:
        raise ValidationError("问卷已更新，请刷新后重试。")
    normalized = normalize_answers(plan, answers)
    writable = writable_group_question_keys(group=group, plan=plan)
    if writable is not None:
        rejected = sorted(_keys_of(plan, normalized) - writable)
        if rejected:
            raise ValidationError(f"以下题目当前不可修改：{'、'.join(rejected)}。")
    response = get_or_create_group_response(
        group=group,
        ruleset_version=version,
        questionnaire_key=plan.key,
        schema_hash=plan.schema_hash,
    )
    return save_draft_answers(response, answers=normalized, schema_hash=plan.schema_hash)


@transaction.atomic
def submit_group_response(
    *,
    version,
    group: Group,
    answers,
    actor,
    due_rounds=frozenset(),
    expected_schema_hash: str = "",
):
    from files.services import reconcile_group_questionnaire_material_checks

    current_actor = _require_group_member(group, actor)
    plan = questionnaire_plan(version)
    if plan.subject != "group":
        raise ValidationError("当前赛制问卷不是分组合唱组问卷。")
    if expected_schema_hash and expected_schema_hash != plan.schema_hash:
        raise ValidationError("问卷已更新，请刷新后重试。")
    normalized = normalize_answers(plan, answers)
    scope = group_material_write_scope(group)
    if scope is GroupMaterialWriteScope.NONE:
        # A closed window means "not now", not "submit nothing": silently dropping every
        # answer would record a submission that contains nothing the group actually wrote.
        raise ValidationError("该分组合唱组当前不接受材料提交。")
    if scope is GroupMaterialWriteScope.SUPPLEMENT_ONLY:
        # Partial submit is the point of the supplement flow: the page sends the whole
        # form, and only the questions staff sent back are written.
        writable = writable_group_question_keys(group=group, plan=plan) or frozenset()
        normalized = {key: value for key, value in normalized.items() if key in writable}
    response = get_or_create_group_response(
        group=group,
        ruleset_version=version,
        questionnaire_key=plan.key,
        schema_hash=plan.schema_hash,
    )
    merged = dict(response.answers or {})
    merged.update(normalized)
    missing = missing_required(
        plan,
        registration=None,
        answers=merged,
        context=build_group_submission_context(version=version, group=group),
        due_rounds=due_rounds,
        files=current_group_answer_files(group),
    )
    if missing:
        raise ValidationError(f"以下必填项尚未填写：{'、'.join(missing)}。")
    saved = save_draft_answers(response, answers=normalized, schema_hash=plan.schema_hash)
    reconcile_group_questionnaire_material_checks(group=group, version=version, plan=plan)
    submitted = mark_submitted(saved)
    from common.models import AuditLog

    AuditLog.objects.create(
        operator=current_actor,
        action_type=AuditLog.ActionType.UPDATE_REGISTRATION,
        target=f"QuestionnaireResponse:{submitted.pk}",
        old_value=saved.status,
        new_value=submitted.status,
        note="group_questionnaire_submit",
    )
    return submitted
