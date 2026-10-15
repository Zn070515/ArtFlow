"""Provision the built-in 2026 live challenge ruleset (§八).

The format is a *starting draft*, not a rule type. What is fixed is the algorithm — five
challenge turns at most, seat inheritance, a weighted podium that ignores the challenge
scores — while the numbers beside it (participants, seats, groups, both weight pairs, the
judge lists) are the operators'. ``ruleset.services.validate_binding`` and
``_validate_2026_live_contract`` enforce that those numbers relate coherently; nothing
requires them to equal the built-in's pre-fill.

What this module adds is *arrival*: creating a ruleset from the system built-in template also
creates the first-round physical round, binds it, and writes the platform-owned binding keys,
so staff only fill in the four operator items. Nothing here locks anything — a
built-in-derived ruleset stays an ordinary editable ruleset whose values happen to be
pre-filled.

The binding is written to :class:`~ruleset.models.ContestRuleset` and never to a
``RulesetVersion``: a version's ``binding`` is produced by ``_snapshot_binding`` at freeze
time and read from there, so anything written onto a draft version would never be read.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from accounts.services import require_current_staff
from common.authority import CONTEST_ROUND_STATE, authority_write
from common.lifecycle import runtime_is_test
from common.models import AuditLog
from core.services import lock_activity_for_action
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Max

from .models import ContestRuleset, RulesetVersion
from .services import (
    LIVE_CHALLENGE_FORMAT_KEY,
    _snapshot_binding,
    create_ruleset_version,
    current_frozen_version,
    update_ruleset_binding,
)
from .templates import (
    LIVE_2026_BUILTIN_KEY,
    LIVE_2026_DEFAULTS,
    LIVE_2026_FIRST_ROUND_KEY,
    LIVE_2026_GROUP_COUNT,
    LIVE_2026_GROUP_SIZE,
    LIVE_2026_PODIUM_KEYS,
    LIVE_2026_SEAT_COUNT,
)

LIVE_2026_FIRST_ROUND_NAME = "第一轮"


def is_live_2026_template(template) -> bool:
    """Whether a ``RulesetTemplate`` is the system built-in 2026 live format."""

    return template is not None and getattr(template, "builtin_key", "") == LIVE_2026_BUILTIN_KEY


def live_2026_binding_preset() -> dict:
    """The platform-owned binding keys: the part of the format that is not a choice.

    Deliberately excludes the four operator items — both weight pairs and both judge lists.
    The document leaves both ratios undecided and says we must not settle them for the
    operators (it names 40/60, 30/70 and 50/50 as ratios *we* may not pick), so a preset
    must never pre-fill them. Operators remain free to choose any pair that sums to 100%.
    """

    return {
        "format_key": LIVE_CHALLENGE_FORMAT_KEY,
        **LIVE_2026_DEFAULTS,
        "order_policy": "official_number",
        **LIVE_2026_PODIUM_KEYS,
    }


@dataclass(frozen=True)
class ReadinessItem:
    """One line of the "我还差什么" checklist.

    ``ready`` is decided by the freeze gate's own validators, never by a second opinion
    written beside them — otherwise the page could say "全部就绪" and the freeze still fail.
    """

    key: str
    label: str
    ready: bool
    message: str = ""


def preflight_live_2026(version) -> list[ReadinessItem]:
    """Run the freeze gate's validators for a 2026 ruleset and report what each one says.

    The checks run in the same order freeze runs them and short-circuit the same way, so the
    page's answer and the freeze's answer cannot drift apart.
    """

    from .compiler import ValidationReport, compile_definition
    from .services import (
        RulesetInvalidError,
        _snapshot_binding,
        _validate_2026_live_contract,
        _validate_frozen_questionnaire,
        _validate_successor_questionnaire,
        build_bound_context,
        validate_binding,
        validate_definition_completeness,
    )

    ruleset = version.ruleset
    items: list[ReadinessItem] = []

    def _blocked(key: str, label: str, message: str) -> None:
        items.append(ReadinessItem(key=key, label=label, ready=False, message=message))

    def _ready(key: str, label: str) -> None:
        items.append(ReadinessItem(key=key, label=label, ready=True))

    try:
        normalized = validate_binding(
            ruleset,
            _snapshot_binding(ruleset),
            require_live_challenge_complete=True,
        )
    except ValidationError as exc:
        _blocked(
            "binding",
            "人数、分组、两套权重与三轮评委齐备",
            _readiness_message(exc),
        )
        return items
    _ready("binding", "人数、分组、两套权重与三轮评委齐备")

    try:
        bound_context = build_bound_context(version, normalized)
        report, plan = compile_definition(version.definition, context=bound_context, bound=True)
        completeness = validate_definition_completeness(version.definition)
        if completeness:
            report = ValidationReport(report.issues + completeness)
        if not report.passes():
            raise RulesetInvalidError(report, plan)
    except (ValidationError, RulesetInvalidError) as exc:
        _blocked("definition", "赛制定义可以编译（晋级名额与席位数一致）", _readiness_message(exc))
        return items
    _ready("definition", "赛制定义可以编译（晋级名额与席位数一致）")

    try:
        _validate_2026_live_contract(json.loads(version.definition), normalized)
    except (ValidationError, ValueError) as exc:
        _blocked(
            "round", "第一轮的评分轮、评委、晋级名额与分组都和配置一致", _readiness_message(exc)
        )
        return items
    _ready("round", "第一轮的评分轮、评委、晋级名额与分组都和配置一致")

    try:
        _validate_frozen_questionnaire(version.definition, normalized)
    except ValidationError as exc:
        _blocked("questionnaire", "选手问卷与第二、三轮材料契约齐备", _readiness_message(exc))
        return items
    _ready("questionnaire", "选手问卷与第二、三轮材料契约齐备")

    try:
        _validate_successor_questionnaire(
            RulesetVersion._base_manager.filter(
                ruleset_id=ruleset.pk, status=RulesetVersion.Status.FROZEN
            ).first(),
            version,
        )
    except ValidationError as exc:
        _blocked("successor", "换版后的问卷答案可以承接", _readiness_message(exc))
        return items
    _ready("successor", "换版后的问卷答案可以承接")
    return items


def _readiness_message(error: Exception) -> str:
    """A compile failure's first ERROR, for the checklist line."""

    report = getattr(error, "report", None)
    if report is None:
        messages = getattr(error, "messages", None)
        if messages:
            return " ".join(str(message) for message in messages)
        return str(error)
    errors = [issue.message for issue in report.issues if issue.severity.value == "error"]
    return errors[0] if errors else "赛制定义未通过校验。"


@dataclass(frozen=True)
class LiveChallengeCounts:
    """The 2026 numbers as the runtime reads them off a frozen binding."""

    participant_count: int
    seat_count: int
    group_count: int
    group_size: int
    challenge_count: int


def live_challenge_counts_from_binding(binding) -> LiveChallengeCounts:
    """Read the live counts out of a binding snapshot.

    ``group_count``/``group_size`` are absent from every binding frozen before the counts
    became parameters. They default to the built-in 5x3 rather than being back-filled: the
    frozen binding is part of ``_authority_hash``, so rewriting one would invalidate every
    audited ``StageResult`` that already points at it.

    踢馆人数 is derived, never read from storage — a stored mirror keeps the frozen record
    self-describing, but the arithmetic is the definition.
    """

    config = (binding or {}).get("live_challenge")
    if not isinstance(config, dict) or not config:
        raise ValidationError("冻结赛制尚未配置现场踢馆人数。")
    try:
        participant_count = int(config["participant_count"])
        seat_count = int(config["seat_count"])
    except (KeyError, TypeError, ValueError):
        raise ValidationError("冻结赛制的现场踢馆人数配置不完整。") from None
    return LiveChallengeCounts(
        participant_count=participant_count,
        seat_count=seat_count,
        group_count=int(config.get("group_count") or LIVE_2026_GROUP_COUNT),
        group_size=int(config.get("group_size") or LIVE_2026_GROUP_SIZE),
        challenge_count=participant_count - seat_count,
    )


def live_challenge_counts(version) -> LiveChallengeCounts:
    """Read the live counts off a ruleset version's frozen binding."""

    return live_challenge_counts_from_binding(getattr(version, "binding", None))


def _counts_if_binding_the_round(binding, contest_round):
    """The counts in ``binding``, but only when it is the one that binds this round."""

    config = (binding or {}).get("live_challenge") or {}
    if not isinstance(config, dict) or not config:
        return None
    first_round_key = str(config.get("podium_first_round_key") or LIVE_2026_FIRST_ROUND_KEY)
    bound = ((binding or {}).get("round_keys") or {}).get(first_round_key)
    if bound in (None, "") or str(bound) != str(contest_round.pk):
        return None
    return live_challenge_counts_from_binding(binding)


def live_challenge_counts_for_round(contest_round, *, require: bool = False, version=None):
    """Resolve the counts for the 2026 ruleset governing this physical round.

    The *current* frozen authority wins, and a historical caller must name its version
    explicitly. Scanning every ``FROZEN`` row for one that happens to bind this round would
    silently serve yesterday's numbers: a successor version may re-bind the same physical
    round, and ``_demote_prior_current`` only clears ``is_current`` — the superseded row stays
    ``FROZEN`` forever.

    Before the freeze the editable ``ContestRuleset`` surface carries the counts, which is the
    same fallback ``_live_group_stage_for_round`` uses.
    """

    if version is None:
        version = current_frozen_version(contest_round.activity)
    if version is not None:
        counts = _counts_if_binding_the_round(version.binding, contest_round)
        if counts is not None:
            return counts
    ruleset = ContestRuleset.objects.filter(activity_id=contest_round.activity_id).first()
    if ruleset is not None:
        pre_freeze = _bound_first_round(ruleset)
        if pre_freeze is not None and pre_freeze.pk == contest_round.pk:
            return live_challenge_counts_from_binding(_snapshot_binding(ruleset))
    if require:
        raise ValidationError("该轮次没有绑定当前已冻结的 2026 现场赛制。")
    return None


def live_challenge_counts_for_activity(activity, *, require: bool = False):
    """The counts governing an activity's live format, frozen version first."""

    version = current_frozen_version(activity)
    if version is not None:
        config = (version.binding or {}).get("live_challenge") or {}
        if isinstance(config, dict) and config:
            return live_challenge_counts_from_binding(version.binding)
    ruleset = ContestRuleset.objects.filter(activity=activity).first()
    if ruleset is not None and ruleset.live_challenge:
        return live_challenge_counts_from_binding(_snapshot_binding(ruleset))
    if require:
        raise ValidationError("该活动没有配置 2026 现场踢馆赛制。")
    return None


def _bound_first_round(ruleset: ContestRuleset, *, lock: bool = False):
    """The physical ContestRound the binding's first-round key points at, if any."""

    from singer_contest.models import ContestRound

    config = ruleset.live_challenge or {}
    if str(config.get("format_key") or "") != LIVE_CHALLENGE_FORMAT_KEY:
        return None
    first_round_key = str(config.get("podium_first_round_key") or LIVE_2026_FIRST_ROUND_KEY)
    round_id = (ruleset.round_keys or {}).get(first_round_key)
    if round_id in (None, ""):
        return None
    queryset = ContestRound.objects.select_for_update() if lock else ContestRound.objects
    return queryset.filter(pk=round_id, activity_id=ruleset.activity_id).first()


@transaction.atomic
def apply_live_2026_counts(ruleset: ContestRuleset, version: RulesetVersion, *, operator):
    """Keep every copy of the seat count in step.

    Three facts carry it: the binding, the physical first round's ``advance_count`` (which is
    what writes ``ScoreSummary.is_advanced``, and what the challenge service reads), and the
    definition's qualifier SELECT. Leaving any one behind makes the numbers contradict each
    other, and the definition is the one that used to make a reshaped format unfreezable —
    the freeze check could only *report* that disagreement, never repair it, because
    rewriting a definition at freeze would move ``content_hash``.

    Repairing it while the version is still a DRAFT costs nothing: nothing is audited against
    a draft's hash yet.
    """

    from singer_contest.models import ContestRound

    from .services import _with_first_round_select_count, update_ruleset_definition_sections

    current_operator = require_current_staff(operator)
    lock_activity_for_action(ruleset.activity)
    locked = ContestRuleset.objects.select_for_update().get(pk=ruleset.pk)
    config = locked.live_challenge or {}
    if str(config.get("format_key") or "") != LIVE_CHALLENGE_FORMAT_KEY:
        return None
    seat_count = live_challenge_counts_from_binding(_snapshot_binding(locked)).seat_count
    first_round_key = str(config.get("podium_first_round_key") or LIVE_2026_FIRST_ROUND_KEY)

    contest_round = _bound_first_round(locked, lock=True)
    if contest_round is not None and contest_round.advance_count != seat_count:
        if contest_round.status != ContestRound.Status.DRAFT or contest_round.is_locked:
            raise ValidationError(
                "第一轮已准备或已锁定，不能修改晋级人数。请先在轮次页面把它重置为草稿，"
                "再回到这里修改。"
            )
        with authority_write(CONTEST_ROUND_STATE):
            contest_round.advance_count = seat_count
            contest_round.save(update_fields=["advance_count"])
        AuditLog.objects.create(
            operator=current_operator,
            action_type=AuditLog.ActionType.OTHER,
            target=f"ContestRound:{contest_round.pk}",
            new_value=json.dumps({"advance_count": seat_count}, ensure_ascii=False),
            note="apply_live_2026_counts",
        )

    locked_version = RulesetVersion._base_manager.select_for_update().get(pk=version.pk)
    if locked_version.status == RulesetVersion.Status.DRAFT:
        try:
            root = json.loads(locked_version.definition)
        except (TypeError, ValueError):
            root = None
        nodes = root.get("nodes") if isinstance(root, dict) else None
        if isinstance(nodes, list):
            updated = _with_first_round_select_count(nodes, first_round_key, seat_count)
            if updated is not None and updated != nodes:
                update_ruleset_definition_sections(
                    locked_version, sections={"nodes": updated}, operator=current_operator
                )
                AuditLog.objects.create(
                    operator=current_operator,
                    action_type=AuditLog.ActionType.OTHER,
                    target=f"RulesetVersion:{locked_version.pk}",
                    new_value=json.dumps({"select_count": seat_count}, ensure_ascii=False),
                    note="apply_live_2026_counts",
                )
    return contest_round


def _first_round_for(ruleset: ContestRuleset):
    """The already-bound first round, or a freshly created one.

    Only the fields that are part of the format are set. ``judge_count``,
    ``minimum_judge_count`` and the rubric stay empty: those are the operator's, and the
    freeze contract refuses until they exist.
    """

    from singer_contest.models import ContestRound

    bound_id = (ruleset.round_keys or {}).get(LIVE_2026_FIRST_ROUND_KEY)
    if bound_id not in (None, ""):
        existing = ContestRound.objects.filter(pk=bound_id, activity_id=ruleset.activity_id).first()
        if existing is not None:
            return existing
    next_sequence = (
        ContestRound.objects.filter(activity_id=ruleset.activity_id).aggregate(
            max_sequence=Max("sequence")
        )["max_sequence"]
        or 0
    ) + 1
    with authority_write(CONTEST_ROUND_STATE):
        return ContestRound.objects.create(
            activity_id=ruleset.activity_id,
            round_type=ContestRound.RoundType.PRELIMINARY,
            sequence=next_sequence,
            name=LIVE_2026_FIRST_ROUND_NAME,
            scoring_mode=ContestRound.ScoringMode.AVERAGE,
            score_completion_mode=ContestRound.CompletionMode.MINIMUM_VALID,
            advance_count=LIVE_2026_SEAT_COUNT,
            roster_source=ContestRound.RosterSource.APPROVED,
        )


@transaction.atomic
def provision_live_2026_ruleset(activity, *, template, name, operator) -> RulesetVersion:
    """Create or reuse the activity's ruleset from the 2026 built-in, pre-filled.

    Mirrors an ordinary ruleset creation — one ``ContestRuleset`` per activity, a new DRAFT
    version from the template's definition — and adds the first round and the binding keys.
    """

    current_operator = require_current_staff(operator)
    lock_activity_for_action(activity)
    ruleset = ContestRuleset.objects.select_for_update().filter(activity=activity).first()
    if ruleset is None:
        ruleset = ContestRuleset(activity=activity, created_by=current_operator)
    ruleset.name = name or ruleset.name
    ruleset.source_template = template
    ruleset.is_test_data = runtime_is_test(activity)
    ruleset.save()

    contest_round = _first_round_for(ruleset)

    # Reuse the whole surface: ``update_ruleset_binding`` replaces every field it is given,
    # so a partial payload would clear the keys another editor already set.
    current = _snapshot_binding(ruleset)
    update_ruleset_binding(
        ruleset,
        binding={
            **current,
            "round_keys": {
                **current["round_keys"],
                LIVE_2026_FIRST_ROUND_KEY: contest_round.pk,
            },
            "live_challenge": {
                **(current.get("live_challenge") or {}),
                **live_2026_binding_preset(),
            },
        },
        operator=current_operator,
    )

    version = create_ruleset_version(
        ruleset, definition=template.definition, created_by=current_operator
    )
    # ``update_ruleset_binding`` writes no audit record of its own, so provisioning would
    # otherwise be invisible in the log.
    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"ContestRuleset:{ruleset.pk}",
        new_value=json.dumps(
            {
                "template": template.builtin_key,
                "first_round": contest_round.pk,
                "live_challenge": live_2026_binding_preset(),
            },
            ensure_ascii=False,
        ),
        note="provision_live_2026_ruleset",
    )
    return version
