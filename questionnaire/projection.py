"""Read-only presentation projections for questionnaire-backed registrations.

``SingerRegistration.song_name`` is a legacy, single-song column.  A current
questionnaire may own several songs at once (one per round), so presentation code
must not silently turn one of those answers back into a global song.  This module
provides the small read boundary used by staff, voting, and export views:

* a round-aware caller may ask for that round's ``<round>.song`` answer;
* a context without a round gets an explicit multi-round label;
* activities without a questionnaire retain their legacy value.

The functions are intentionally read-only.  They do not write registrations or
responses and do not participate in any scoring/result authority.
"""

from __future__ import annotations

import json
from collections.abc import Iterable

from ruleset.models import RulesetVersion
from ruleset.services import current_frozen_version

from questionnaire.models import QuestionnaireResponse

MULTI_ROUND_SONG_LABEL = "多轮曲目"
UNANSWERED_SONG_LABEL = "未填写"


def _current_versions_for_activity_ids(activity_ids: Iterable[int]) -> dict[int, RulesetVersion]:
    """Return the current frozen version for each activity in one query."""
    versions = (
        RulesetVersion._base_manager.filter(
            ruleset__activity_id__in=set(activity_ids),
            is_current=True,
            status=RulesetVersion.Status.FROZEN,
        )
        .select_related("ruleset")
        .order_by("-pk")
    )
    result: dict[int, RulesetVersion] = {}
    for version in versions:
        result.setdefault(version.ruleset.activity_id, version)
    return result


def prime_questionnaire_answers(registrations: Iterable) -> list:
    """Attach current questionnaire answers to registrations with bounded queries.

    The attached private attributes are presentation cache only.  A caller can pass
    registrations from a queryset or an already materialized list; the returned list
    is always materialized so templates can safely iterate it more than once.
    """
    rows = list(registrations)
    if not rows:
        return rows
    versions = _current_versions_for_activity_ids(
        row.activity_id for row in rows if getattr(row, "activity_id", None)
    )
    version_ids = [version.pk for version in versions.values()]
    responses = QuestionnaireResponse.objects.filter(
        singer_registration_id__in=[row.pk for row in rows if row.pk],
        ruleset_version_id__in=version_ids,
    ).order_by("-pk")
    response_by_registration: dict[int, QuestionnaireResponse] = {}
    for response_row in responses:
        if response_row.singer_registration_id is None:
            continue
        response_by_registration.setdefault(response_row.singer_registration_id, response_row)
    for row in rows:
        version = versions.get(row.activity_id)
        response: QuestionnaireResponse | None = response_by_registration.get(row.pk)
        row._artflow_questionnaire_version = version
        try:
            row._artflow_questionnaire_active = bool(
                version is not None and json.loads(version.definition).get("questionnaire")
            )
        except (TypeError, ValueError):
            row._artflow_questionnaire_active = version is not None
        row._artflow_questionnaire_answers = (
            dict(response.answers or {})
            if response is not None and response.ruleset_version_id == getattr(version, "pk", None)
            else {}
        )
    return rows


def _answers_for(registration) -> dict:
    if not hasattr(registration, "_artflow_questionnaire_answers"):
        prime_questionnaire_answers([registration])
    return getattr(registration, "_artflow_questionnaire_answers", {})


def questionnaire_value(registration, question_key: str, *, default=""):
    """Read one answer from the current frozen questionnaire, or ``default``."""
    value = _answers_for(registration).get(question_key, default)
    return value if value is not None else default


def round_key_for_round(contest_round) -> str | None:
    """Find the frozen binding key for a contest round, without trusting its name."""
    version = current_frozen_version(contest_round.activity)
    if version is None:
        return None
    for key, round_id in (version.binding or {}).get("round_keys", {}).items():
        if str(round_id) == str(contest_round.pk):
            return str(key)
    return None


def questionnaire_song_for_round(registration, contest_round, *, default="") -> str:
    """Return the song answer belonging to ``contest_round``.

    The conventional ``<round-key>.song`` question is a product-level projection,
    not a new authority field.  If the activity is legacy, the old column remains the
    fallback; if the questionnaire exists but the answer is empty, an explicit label
    is returned by the caller when desired.
    """
    round_key = round_key_for_round(contest_round)
    if not round_key:
        return str(default or "")
    value = questionnaire_value(registration, f"{round_key}.song", default="")
    if isinstance(value, str) and value.strip():
        return value.strip()
    if getattr(registration, "song_name", "") and not getattr(
        registration, "_artflow_questionnaire_active", False
    ):
        return registration.song_name
    return str(default or "")


def generic_song_label(registration) -> str:
    """Return a safe label for a list that has no round context."""
    _answers_for(registration)
    if getattr(registration, "_artflow_questionnaire_active", False):
        return MULTI_ROUND_SONG_LABEL
    return str(getattr(registration, "song_name", "") or "")
