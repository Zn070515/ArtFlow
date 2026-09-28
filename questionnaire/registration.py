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

from common.lifecycle import runtime_is_test
from django.core.exceptions import ValidationError
from django.db import transaction
from singer_contest.models import RoundEntry, SingerRegistration

from .compiler import QuestionnairePlan, compile_questionnaire
from .models import QuestionnaireResponse
from .runtime import missing_required
from .services import get_or_create_response, mark_submitted, save_draft_answers


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


def current_answer_files(registration) -> dict:
    """The current file answering each question, keyed by question key.

    Read through the same ``is_current`` flag the storage service maintains, so "what does
    this participant's second-round accompaniment hold right now" has one answer.
    """
    from files.models import SubmissionFile

    return {
        row.question_key: row
        for row in SubmissionFile.objects.filter(
            singer_registration=registration, is_current=True
        ).exclude(question_key="")
    }


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
    registration.save(update_fields=[*fields, "updated_at"])


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
    response = get_or_create_response(
        registration=registration,
        ruleset_version=version,
        questionnaire_key=plan.key,
        schema_hash=plan.schema_hash,
        is_test_data=registration.is_test_data,
    )
    return registration, response


@transaction.atomic
def save_draft(*, version, registration, answers, schema_hash: str = "") -> QuestionnaireResponse:
    """Persist one autosave: bound answers onto the registration, the rest into the response."""
    plan = questionnaire_plan(version)
    response = get_or_create_response(
        registration=registration,
        ruleset_version=version,
        questionnaire_key=plan.key,
        schema_hash=plan.schema_hash,
        is_test_data=registration.is_test_data,
    )
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
) -> QuestionnaireResponse:
    """Re-check and finish a registration.

    Everything is recomputed from the frozen version rather than trusted from the draft:
    the response is re-read, the context is rebuilt from server facts, conditions are
    re-evaluated, and the due-now required questions are proven answered before anything
    is marked submitted. A refusal leaves the draft exactly as it was, so a participant
    who is missing one field loses nothing else.
    """
    if version.status != type(version).Status.FROZEN or not version.is_current:
        raise ValidationError("只有当前已冻结赛制可以提交报名。")
    plan = questionnaire_plan(version)
    response = get_or_create_response(
        registration=registration,
        ruleset_version=version,
        questionnaire_key=plan.key,
        schema_hash=plan.schema_hash,
        is_test_data=registration.is_test_data,
    )
    if response.status != QuestionnaireResponse.Status.DRAFT:
        raise ValidationError("报名已提交。")

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
    registration.pre_status = SingerRegistration.PreStatus.SUBMITTED
    registration.save(update_fields=["pre_status", "updated_at"])
    return mark_submitted(saved)
