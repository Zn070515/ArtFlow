"""Persistence for questionnaire answers (§P3).

Deliberately thin, and separate from the compiler: the compiler decides what a
questionnaire *means*, this decides what was *stored*. The lifecycle that wraps the two —
creating a draft registration on first open, validating a whole submission, reopening one
question for a supplement — belongs to the registration service (§P3/P6), not here.

Nothing here decides who may write. Authority is checked by the caller, at the boundary
where the actor is known.
"""

from __future__ import annotations

import hashlib
import json

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .models import QuestionnaireResponse


def answer_base(value) -> str:
    """A stable, opaque token for one stored answer.

    The page renders these back, and a write says which base it was built on. Comparing
    tokens rather than raw values keeps the comparison independent of the shape a client
    happens to send: the server owns the canonical form, so an untouched checkbox
    (``False`` stored, ``false`` in the DOM, absent in the database) can never look like a
    change.
    """
    canonical = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def answer_bases(answers: dict) -> dict[str, str]:
    return {key: answer_base(value) for key, value in (answers or {}).items()}


class QuestionStale(ValidationError):
    """A write was built on an answer someone else has since changed.

    Carries the server's value and the writer's so the page can show the difference
    instead of silently picking a winner.
    """

    def __init__(self, *, conflicts: list[dict]) -> None:
        super().__init__("部分题目已被其他成员修改。")
        self.conflicts = conflicts


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
    response: QuestionnaireResponse,
    *,
    answers: dict | None = None,
    changes: list[dict] | None = None,
    schema_hash: str = "",
) -> QuestionnaireResponse:
    """Merge ``answers`` (or apply ``changes``) under the row lock.

    This is the low-level writer and it does not decide *who* may write — authority belongs
    to the activity's phase and the staff supplement grants, checked by
    :func:`questionnaire.registration.save_draft`. What it refuses is a write built on a
    questionnaire shape the version no longer has, so an open browser is told to refresh
    instead of merging answers the current form cannot show.

    ``changes`` is the compare-and-set form, used where more than one person edits the same
    response: each entry names the answer base it was built on, and a base that no longer
    matches raises :class:`QuestionStale` instead of overwriting. Two people editing
    different questions both succeed; two editing the same one are told, rather than one of
    them silently losing their text — which is what a whole-form merge does.
    """
    locked = QuestionnaireResponse.objects.select_for_update().get(pk=response.pk)
    if schema_hash and locked.schema_hash and schema_hash != locked.schema_hash:
        raise ValidationError("问卷已更新，请刷新后重试。")
    merged = dict(locked.answers or {})
    if changes is not None:
        conflicts = [
            {
                "key": change["key"],
                "server": merged.get(change["key"]),
                "local": change.get("value"),
                # The base to retry against if the author decides their version should win.
                "base": answer_base(merged.get(change["key"])),
            }
            for change in changes
            if answer_base(merged.get(change["key"])) != str(change.get("base") or "")
        ]
        if conflicts:
            raise QuestionStale(conflicts=conflicts)
        for change in changes:
            merged[change["key"]] = change["value"]
    else:
        merged.update(answers or {})
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
