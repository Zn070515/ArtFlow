"""Persistence for questionnaire answers (§P3).

Deliberately thin, and separate from the compiler: the compiler decides what a
questionnaire *means*, this decides what was *stored*. The lifecycle that wraps the two —
creating a draft registration on first open, validating a whole submission, reopening one
question for a supplement — belongs to the registration service (§P3/P6), not here.

Nothing here decides who may write. Authority is checked by the caller, at the boundary
where the actor is known.
"""

from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .models import QuestionnaireResponse


@transaction.atomic
def get_or_create_response(
    *,
    registration=None,
    group=None,
    ruleset_version,
    questionnaire_key: str,
    schema_hash: str = "",
    is_test_data: bool = False,
) -> QuestionnaireResponse:
    """The response for one registration against one version, created on first open.

    Idempotent: the unique constraint is the identity, so a participant who reloads the
    page re-reads their draft rather than starting a second one.
    """
    if (registration is None) == (group is None):
        raise ValidationError("问卷响应必须且只能关联一个提交主体。")
    subject = (
        QuestionnaireResponse.Subject.GROUP
        if group is not None
        else QuestionnaireResponse.Subject.PARTICIPANT
    )
    identity = {"group": group} if group is not None else {"singer_registration": registration}
    response, _created = QuestionnaireResponse.objects.get_or_create(
        **identity,
        ruleset_version=ruleset_version,
        questionnaire_key=questionnaire_key,
        defaults={
            "subject": subject,
            "schema_hash": schema_hash,
            "is_test_data": is_test_data,
        },
    )
    return response


def get_or_create_group_response(*, group, ruleset_version, questionnaire_key, schema_hash=""):
    return get_or_create_response(
        group=group,
        ruleset_version=ruleset_version,
        questionnaire_key=questionnaire_key,
        schema_hash=schema_hash,
        is_test_data=group.is_test_data,
    )


@transaction.atomic
def save_draft_answers(
    response: QuestionnaireResponse, *, answers: dict, schema_hash: str = ""
) -> QuestionnaireResponse:
    """Merge ``answers`` into the stored response, under the row lock.

    This is the low-level writer and it does not decide *who* may write — authority belongs
    to the activity's phase and the staff supplement grants, checked by
    :func:`questionnaire.registration.save_draft`. What it refuses is a write built on a
    questionnaire shape the version no longer has, so an open browser is told to refresh
    instead of merging answers the current form cannot show.
    """
    locked = QuestionnaireResponse.objects.select_for_update().get(pk=response.pk)
    if schema_hash and locked.schema_hash and schema_hash != locked.schema_hash:
        raise ValidationError("问卷已更新，请刷新后重试。")
    merged = dict(locked.answers or {})
    merged.update(answers)
    locked.answers = merged
    if schema_hash:
        locked.schema_hash = schema_hash
    locked.save(update_fields=["answers", "schema_hash", "updated_at"])
    return locked


@transaction.atomic
def mark_submitted(response: QuestionnaireResponse) -> QuestionnaireResponse:
    """Freeze the response as the participant's statement of record.

    Idempotent: re-submitting keeps the original ``submitted_at``, so the timestamp always
    means "when this participant first submitted", not "when someone last clicked".
    """
    locked = QuestionnaireResponse.objects.select_for_update().get(pk=response.pk)
    if locked.status == QuestionnaireResponse.Status.SUBMITTED:
        return locked
    locked.status = QuestionnaireResponse.Status.SUBMITTED
    locked.submitted_at = timezone.now()
    locked.save(update_fields=["status", "submitted_at", "updated_at"])
    return locked
