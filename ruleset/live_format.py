"""Provision the built-in 2026 live challenge ruleset (§八).

The format is a *starting draft*, not a rule type. What is fixed is the algorithm — one
challenge turn per singer who missed an initial seat, seat inheritance, a weighted podium
that ignores the challenge scores — while the numbers beside it (participants, seats, groups,
both weight pairs, the judge lists) are the operators'. ``ruleset.services.validate_binding``
and ``_validate_2026_live_contract`` enforce that those numbers relate coherently; nothing
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
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Max

from .models import ContestRuleset, RulesetVersion
from .services import (
    FREEZE_GATE_LABELS,
    LIVE_CHALLENGE_FORMAT_KEY,
    RulesetInvalidError,
    _compile_frozen_definition,
    _live_first_round,
    _live_first_round_groups,
    _live_first_round_judges,
    _live_first_round_rubric,
    _live_first_round_seats,
    _normalize_live_challenge_weights,
    _normalize_live_counts,
    _normalize_live_judges,
    _normalize_live_podium,
    _prior_current_frozen,
    _snapshot_binding,
    _validate_2026_live_contract,
    _validate_frozen_questionnaire,
    _validate_successor_questionnaire,
    create_ruleset_version,
    current_frozen_round_ids,
    current_frozen_version,
    editable_ruleset_version,
    evaluate_freeze_gate,
    frozen_round_configuration_message,
    live_2026_first_round_key,
    supersede_ruleset_version,
    update_ruleset_binding,
    validate_binding,
    version_is_editable,
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


def _is_live_2026_binding(binding: dict) -> bool:
    live = (binding or {}).get("live_challenge") or {}
    return isinstance(live, dict) and live.get("format_key") == LIVE_CHALLENGE_FORMAT_KEY


LIVE_2026_FIRST_ROUND_NAME = "第一轮"


def first_round_configuration_signature(first_round) -> str:
    """The first round's own optimistic-concurrency token.

    Deliberately scoped to this round, not the activity: editing an unrelated round must
    not invalidate a save on the 2026 workbench.
    """

    if first_round is None:
        return ""
    snapshot = {
        "pk": first_round.pk,
        **{
            field: getattr(first_round, field)
            for field in (
                "name",
                "scoring_mode",
                "score_completion_mode",
                "judge_count",
                "minimum_judge_count",
                "rubric_id",
                "advance_count",
                "roster_source",
                "roster_source_stage",
            )
        },
    }
    return json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


#: Marks the round a successor draft owns, so the rounds list does not show two identical
#: 第一轮 rows with no way to tell which one the running authority still uses.
FIRST_ROUND_CLONE_SUFFIX = "（后继）"


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
    """One line of the "准备清单".

    ``state`` is one of ``ready`` / ``blocked`` / ``unknown``: a row whose own precondition
    has not been met yet is genuinely unknown, and saying "missing" about it would be a second
    lie of the same kind as saying "ready" about it.
    """

    key: str
    label: str
    state: str
    message: str = ""

    @property
    def ready(self) -> bool:
        return self.state == "ready"

    @property
    def unknown(self) -> bool:
        return self.state == "unknown"


#: The 准备清单's rows, in the order an operator works through them. Each row names the
#: concern; the validator behind it is the freeze's own, never a second opinion beside it.
#: The keys the freeze gate also names come from there, so the two readings of one check
#: cannot end up calling it different things.
READINESS_LABELS: dict[str, str] = {
    "counts": "第一轮参赛人数、晋级人数与分组数自洽",
    "weights": "踢馆成绩权重（第一轮 + 踢馆）合计 100%",
    "podium": "冠亚季军成绩权重（第一轮 + 第三轮）合计 100%",
    "judges": "踢馆评委与第三轮评委齐备（含最低有效评委数）",
    "round_seats": "第一轮的晋级名额与人数配置一致",
    "round_judges": "第一轮按最低有效评委数评分并配好评委人数",
    "rubric": "三轮统一评分标准已配置",
    "groups": "第一轮分组名单已录好并冻结",
    "round_contract": "现场赛制不依赖观众投票，且第一轮绑定了物理评分轮",
    **FREEZE_GATE_LABELS,
}

#: The rows the coarse ``round_contract`` row is the catch-all for.
_ROUND_ROW_KEYS = frozenset({"round_seats", "round_judges", "rubric", "groups"})


#: The operator-facing task layer. One task may be backed by several validators, but the
#: task list itself is fixed: a validator that only becomes checkable after its prerequisite
#: passes must not change the denominator, or progress appears to stall (or go backwards).
_PREPARATION_TASK_SPECS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("counts", "比赛人数与晋级人数", ("counts", "round_seats")),
    ("challenge_weights", "踢馆成绩计算", ("weights",)),
    ("podium_weights", "冠亚季军成绩计算", ("podium",)),
    ("judges", "三轮评委", ("judges", "round_judges")),
    ("rubric", "三轮统一评分标准", ("rubric",)),
    ("groups", "第一轮分组", ("groups",)),
    ("questionnaire", "选手问卷", ("questionnaire",)),
)

#: Every granular row that belongs to a user task. Rows outside this set are system checks.
PREPARATION_TASK_ROW_KEYS = frozenset(
    key for _task, _label, keys in _PREPARATION_TASK_SPECS for key in keys
)


@dataclass(frozen=True)
class PreparationTask:
    """One operator task, backed by one or more readiness validators."""

    key: str
    label: str
    ready: bool
    pending: bool
    detail: str = ""


def freeze_blocker(version, *, binding: dict | None = None):
    """The first check the freeze would refuse on, or ``None`` when it would pass.

    This is the page's "正式冻结检查": it returns what
    :func:`~ruleset.services.evaluate_freeze_gate` reports, and that gate *is* the walk
    :func:`~ruleset.services.freeze_ruleset_version` performs. The checklist below may be
    more granular, but this line is by construction the answer the freeze button gives.
    """

    return evaluate_freeze_gate(version, binding=binding).blocker


def live_2026_readiness(version) -> list[ReadinessItem]:
    """Every 准备清单 row with its own verdict — no short-circuiting.

    The freeze asks "may I stop?" and the first refusal is the answer. This asks "what is
    still missing?" and has to answer all of it at once: a fresh built-in draft is missing
    the ratios, the judge panels, the rubric, the chorus grouping and usually the
    questionnaire, and a page that reports only the first of those is not a checklist.

    Every probe is the validator the freeze itself runs. Two rows are deliberately coarse —
    ``binding`` and ``round_contract`` — and appear only when their granular siblings all
    passed and the coarse validator still refuses, so a failure no granular row covers is
    reported rather than hidden behind "全部就绪".
    """

    ruleset = version.ruleset
    binding = _snapshot_binding(ruleset)
    live_config = binding.get("live_challenge") or {}
    if not live_config:
        return [_blocked_item("counts", "当前赛制尚未声明 2026 现场踢馆赛制。")]

    root = _definition_root(version)
    round_keys = binding.get("round_keys") or {}
    live_format_key = str(live_config.get("format_key") or "")

    # The gate is the freeze's own walk. Its normalized binding is what the definition row
    # compiles against, and its verdict is what the page prints as the first blocker.
    evaluation = evaluate_freeze_gate(version)
    normalized = evaluation.normalized_binding

    items = []
    if evaluation.blocker is not None and evaluation.blocker.key == "version":
        items.append(_blocked_item("version", evaluation.blocker.message))
    else:
        items.append(_ready_item("version"))
    items += [
        _readiness_item("counts", lambda: _normalize_live_counts(live_config)),
        _readiness_item(
            "weights",
            lambda: _normalize_live_challenge_weights(
                live_config, strict=True, live_format_key=live_format_key
            ),
        ),
        _readiness_item(
            "podium",
            lambda: _normalize_live_podium(
                live_config,
                strict=True,
                live_format_key=live_format_key,
                round_keys=round_keys,
            ),
        ),
        _readiness_item("judges", lambda: _normalize_live_judges(live_config, strict=True)),
    ]

    if normalized is None and all(item.ready for item in items):
        items.append(
            _blocked_item(
                "binding",
                evaluation.blocker.message if evaluation.blocker else "赛制绑定未通过校验。",
            )
        )

    if normalized is None:
        items.append(_unknown_item("definition"))
    else:
        items.append(
            _readiness_item("definition", lambda: _compile_frozen_definition(version, normalized))
        )

    # The physical round's own rows read the stored surface directly, so they answer even
    # while the binding rows above are still refusing: "第一轮评分表还没填" is exactly what
    # the operator should be told at the same time as the ratios, not after them.
    try:
        first_round = _live_first_round(live_config, binding)
    except ValidationError as exc:
        items.append(_blocked_item("round_seats", _readiness_message(exc)))
    else:
        # Advancement quota and the chorus grouping are different operator jobs with
        # different fixing pages. Keeping them in one row let the checklist send a staff
        # member to the round editor when the real missing fact was an unbound GroupStage.
        items.append(
            _readiness_item(
                "round_seats", lambda: _live_first_round_seats(root, live_config, first_round)
            )
        )
        items.append(
            _readiness_item(
                "groups",
                lambda: _live_first_round_groups(root, live_config, binding, first_round),
            )
        )
        items.append(_readiness_item("round_judges", lambda: _live_first_round_judges(first_round)))
        items.append(_readiness_item("rubric", lambda: _live_first_round_rubric(first_round)))

    if normalized is not None and all(item.ready for item in items if item.key in _ROUND_ROW_KEYS):
        items.append(
            _readiness_item(
                "round_contract", lambda: _validate_2026_live_contract(root, normalized)
            )
        )

    # The questionnaire read does not depend on weights or judge lists, so it must not be
    # hidden behind them. When the strict freeze gate stops earlier, ask the same normalizer
    # in its relaxed (editable-surface) mode: the questionnaire's own verdict is then real
    # instead of "unknown", and fixing an unrelated binding no longer makes it appear to
    # complete a task the operator never touched.
    questionnaire_binding = normalized
    if questionnaire_binding is None:
        try:
            questionnaire_binding = validate_binding(
                version.ruleset, _snapshot_binding(version.ruleset)
            )
        except (ValidationError, RulesetInvalidError):
            questionnaire_binding = None
    if questionnaire_binding is None:
        items.append(_unknown_item("questionnaire"))
    else:
        items.append(
            _readiness_item(
                "questionnaire",
                lambda: _validate_frozen_questionnaire(version.definition, questionnaire_binding),
            )
        )

    items.append(
        _readiness_item(
            "successor",
            lambda: _validate_successor_questionnaire(_prior_current_frozen(version), version),
        )
    )
    if evaluation.blocker is not None and evaluation.blocker.key == "finality":
        items.append(_blocked_item("finality", evaluation.blocker.message))
    else:
        items.append(_ready_item("finality"))
    return items


def live_2026_preparation_tasks(version) -> list[PreparationTask]:
    """The stable operator task list, derived from the granular readiness rows.

    The denominator is fixed. A row that is ``unknown`` because its prerequisite has not
    been met yet is still an unfinished task, and it never becomes a *new* task when the
    prerequisite clears — it was always in the same task. This is what makes "I saved two
    weights, so two tasks completed" a true statement instead of a momentarily true one.
    """

    items = {item.key: item for item in live_2026_readiness(version)}
    tasks: list[PreparationTask] = []
    for key, label, row_keys in _PREPARATION_TASK_SPECS:
        rows = [items[row_key] for row_key in row_keys if row_key in items]
        if not rows:
            tasks.append(
                PreparationTask(
                    key=key,
                    label=label,
                    ready=False,
                    pending=True,
                    detail="等待前置条件后自动检查。",
                )
            )
            continue
        blocked = next((row for row in rows if row.state == "blocked"), None)
        unknown = next((row for row in rows if row.unknown), None)
        ready = all(row.ready for row in rows)
        detail_row = blocked or unknown
        tasks.append(
            PreparationTask(
                key=key,
                label=label,
                ready=ready,
                # Unknown is incomplete, not done; ``pending`` only changes the wording.
                pending=not ready and blocked is None,
                detail="" if ready or detail_row is None else detail_row.message,
            )
        )
    return tasks


def _readiness_item(key: str, probe) -> ReadinessItem:
    """Run one validator on its own and report what it alone said."""

    try:
        probe()
    except (ValidationError, RulesetInvalidError, ValueError) as exc:
        return _blocked_item(key, _readiness_message(exc))
    return _ready_item(key)


def _ready_item(key: str) -> ReadinessItem:
    return ReadinessItem(key=key, label=READINESS_LABELS[key], state="ready")


def _blocked_item(key: str, message: str) -> ReadinessItem:
    return ReadinessItem(key=key, label=READINESS_LABELS[key], state="blocked", message=message)


def _unknown_item(key: str) -> ReadinessItem:
    return ReadinessItem(
        key=key,
        label=READINESS_LABELS[key],
        state="unknown",
        message="需要先完成上一项才能检查。",
    )


def _definition_root(version) -> dict:
    """The definition as the live-contract validators want it: a parsed mapping."""

    try:
        root = json.loads(version.definition)
    except (TypeError, ValueError):
        return {}
    return root if isinstance(root, dict) else {}


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
    """The 2026 numbers as the runtime reads them off a frozen binding.

    ``suggested_group_size`` is named that way on purpose. The stored binding key is still
    ``group_size`` — renaming it would strand the suggestion in every already-frozen binding
    and, because the binding is part of ``_authority_hash``, is not worth doing — but nothing
    validates it against anything, and a field called ``group_size`` beside the real contract
    ``group_count`` reads like a rule the actual, unequal group sizes would then violate.
    """

    participant_count: int
    seat_count: int
    group_count: int
    suggested_group_size: int
    challenge_count: int


def live_challenge_counts_from_binding(binding) -> LiveChallengeCounts:
    """Read the live counts out of a binding snapshot.

    ``group_count`` and the suggested group size are absent from every binding frozen before
    the counts became parameters. They default to the built-in 5x3 rather than being
    back-filled: the frozen binding is part of ``_authority_hash``, so rewriting one would
    invalidate every audited ``StageResult`` that already points at it.

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
        suggested_group_size=int(config.get("group_size") or LIVE_2026_GROUP_SIZE),
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
        # A frozen authority owns its rounds' execution configuration. The frozen binding
        # keeps saying 10 seats while the round it binds advances 8, and the challenge
        # service reads the *binding* — so the venue would be told to seat ten singers the
        # round never produced, with no error until the first challenge session. A successor
        # draft re-shapes the format by binding a new round, not by moving this one.
        if contest_round.pk in current_frozen_round_ids(locked, excluding_version=version):
            raise ValidationError(
                frozen_round_configuration_message(contest_round.name or LIVE_2026_FIRST_ROUND_NAME)
            )
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


@dataclass(frozen=True)
class Live2026PreparationSave:
    """What the workbench's one save command produced."""

    version: RulesetVersion
    created_rubric: object | None = None


def _optional_positive_int(value: object, *, label: str) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        number = int(text)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"{label}必须是正整数。") from exc
    if number <= 0:
        raise ValidationError(f"{label}必须是正整数。")
    return number


@transaction.atomic
def save_live_2026_preparation(
    version: RulesetVersion,
    *,
    operator,
    live_challenge: dict,
    base_binding: str | None = None,
    base_binding_revision: int | None = None,
    base_first_round_configuration: str | None = None,
    first_judge_count: object | None = None,
    first_minimum_judges: object | None = None,
    first_rubric=None,
    new_rubric_name: str = "",
    new_rubric_criteria: list[dict] | None = None,
) -> Live2026PreparationSave:
    """The 2026 workbench's one preparation aggregate command.

    Order matters: the activity lock, then the ruleset, version and first round. Binding,
    counts, first-round execution configuration and the rubric are one unit — a save either
    makes all of them agree or changes none of them. The fixed first-round rules (average,
    minimum-valid completion, approved roster) are applied here, not asked as questions.
    """

    from singer_contest.models import ContestRound
    from singer_contest.services import (
        configure_draft_round_from_planning,
        create_scoring_rubric,
    )

    current_operator = require_current_staff(operator)
    lock_activity_for_action(version.ruleset.activity)
    # Same aggregate lock order as the other ruleset writers: Activity -> ContestRuleset
    # -> RulesetVersion. The save command is not a second lock protocol.
    locked_ruleset = ContestRuleset.objects.select_for_update().get(pk=version.ruleset_id)
    locked_version = (
        RulesetVersion.objects.select_for_update().select_related("ruleset").get(pk=version.pk)
    )
    if locked_version.status != RulesetVersion.Status.DRAFT:
        raise ValidationError("只有草稿赛制可以继续准备。")
    if not version_is_editable(locked_version):
        raise ValidationError("这一版赛制已被更新的版本替代，请到最新版本继续准备。")
    locked_first_round = _bound_first_round(locked_ruleset)
    if base_first_round_configuration is not None and base_first_round_configuration != (
        first_round_configuration_signature(locked_first_round)
    ):
        # ``base_binding`` covers the ruleset surface; the first round's configuration is a
        # separate aggregate. Scoped to this round, so editing an unrelated round does not
        # produce a false conflict for the operator.
        raise ValidationError("第一轮配置已被其他工作人员修改，请刷新后重试。")

    binding = _snapshot_binding(locked_ruleset)
    stored_config = dict(locked_ruleset.live_challenge or {})
    stored_config.pop("challenge_count", None)
    posted_config = dict(live_challenge or {})
    posted_config.pop("challenge_count", None)
    binding["live_challenge"] = {**stored_config, **posted_config}
    updated_ruleset = update_ruleset_binding(
        locked_ruleset,
        binding=binding,
        operator=current_operator,
        base_binding=base_binding,
        base_binding_revision=base_binding_revision,
    )
    apply_live_2026_counts(updated_ruleset, locked_version, operator=current_operator)

    judge_count = _optional_positive_int(first_judge_count, label="第一轮评委人数")
    minimum_judges = _optional_positive_int(first_minimum_judges, label="第一轮最低有效评委数")
    if judge_count is not None and minimum_judges is not None and minimum_judges > judge_count:
        raise ValidationError("第一轮最低有效评委数不能超过评委人数。")
    if first_rubric is not None and first_rubric.activity_id != updated_ruleset.activity_id:
        raise ValidationError("评分标准必须属于当前活动。")

    created_rubric = None
    if str(new_rubric_name or "").strip() or new_rubric_criteria:
        if not str(new_rubric_name or "").strip():
            raise ValidationError("新建评分标准必须填写名称。")
        if not new_rubric_criteria:
            raise ValidationError("新建评分标准至少需要一个评分项。")
        created_rubric = create_scoring_rubric(
            updated_ruleset.activity,
            name=new_rubric_name,
            description="",
            criteria=new_rubric_criteria,
            operator=current_operator,
            planning=True,
        )
    rubric = created_rubric or first_rubric

    first_round = _bound_first_round(updated_ruleset)
    if first_round is None:
        if judge_count is not None or minimum_judges is not None or rubric is not None:
            raise ValidationError("还没有绑定第一轮评分轮，无法填写第一轮评委或评分标准。")
    else:
        first_round = ContestRound.objects.get(pk=first_round.pk)
        wanted: dict[str, object] = {
            "advance_count": live_challenge_counts_from_binding(
                _snapshot_binding(updated_ruleset)
            ).seat_count,
            "scoring_mode": ContestRound.ScoringMode.AVERAGE,
            "score_completion_mode": ContestRound.CompletionMode.MINIMUM_VALID,
            "roster_source": ContestRound.RosterSource.APPROVED,
        }
        if judge_count is not None:
            wanted["judge_count"] = judge_count
        if minimum_judges is not None:
            wanted["minimum_judge_count"] = minimum_judges
        if rubric is not None:
            wanted["rubric"] = rubric
        changes: dict[str, object] = {}
        for field, value in wanted.items():
            stored = getattr(first_round, "rubric_id" if field == "rubric" else field)
            target = getattr(value, "pk", value)
            if stored != target:
                changes[field] = value
        effective_judge_count = changes.get("judge_count", first_round.judge_count)
        effective_minimum = changes.get("minimum_judge_count", first_round.minimum_judge_count)
        if (
            isinstance(effective_judge_count, int)
            and isinstance(effective_minimum, int)
            and effective_minimum > effective_judge_count
        ):
            raise ValidationError("第一轮最低有效评委数不能超过评委人数。")
        if changes:
            if first_round.status != ContestRound.Status.DRAFT or first_round.is_locked:
                raise ValidationError(
                    "第一轮已准备或已锁定，不能修改评委人数、最低有效评委数、评分标准或"
                    "晋级人数；请先在轮次页重置，或为这一版赛制复制一个可编辑的第一轮。"
                )
            configure_draft_round_from_planning(
                first_round,
                operator=current_operator,
                configuration=changes,
            )

    saved_version = RulesetVersion.objects.select_related("ruleset").get(pk=locked_version.pk)
    return Live2026PreparationSave(version=saved_version, created_rubric=created_rubric)


@transaction.atomic
def create_live_2026_group_stage(version: RulesetVersion, *, operator):
    """Create (or resume) the workbench-owned first-round group stage.

    Key allocation, the resume check and the INSERT all happen under the Activity lock.
    Two staff clicking at the same time therefore share the unfinished stage or get
    distinct keys — never a duplicate-key ``IntegrityError``.
    """

    from singer_contest.group_chorus import create_group_stage
    from singer_contest.models import GroupStage

    current_operator = require_current_staff(operator)
    lock_activity_for_action(version.ruleset.activity)
    locked_ruleset = ContestRuleset.objects.select_for_update().get(pk=version.ruleset_id)
    locked_version = (
        RulesetVersion.objects.select_for_update().select_related("ruleset").get(pk=version.pk)
    )
    if locked_version.status != RulesetVersion.Status.DRAFT or not version_is_editable(
        locked_version
    ):
        raise ValidationError("只有最新草稿可以创建第一轮分组。")
    if not _is_live_2026_binding(_snapshot_binding(locked_ruleset)):
        raise ValidationError("当前赛制不是 2026 现场踢馆赛制。")

    resumable = (
        GroupStage.objects.select_for_update()
        .filter(
            activity_id=locked_ruleset.activity_id,
            managed_by=GroupStage.ManagedBy.LIVE_2026,
            managed_by_version=locked_version,
            status__in=[GroupStage.Status.DRAFT, GroupStage.Status.CONFIRMED],
        )
        .order_by("-pk")
        .first()
    )
    if resumable is not None:
        return resumable

    binding = _snapshot_binding(locked_ruleset)
    first_round_key = live_2026_first_round_key(binding.get("live_challenge") or {})
    bound_id = (binding.get("group_stage_keys") or {}).get(first_round_key)
    predecessor = None
    if bound_id not in (None, ""):
        predecessor = GroupStage.objects.filter(
            pk=bound_id, activity_id=locked_ruleset.activity_id
        ).first()

    base = GroupStage.LIVE_2026_KEY_PREFIX
    used = set(
        GroupStage.objects.filter(
            activity_id=locked_ruleset.activity_id, stage_key__startswith=base
        ).values_list("stage_key", flat=True)
    )
    stage_key = base
    index = 2
    while stage_key in used:
        stage_key = f"{base}_v{index}"
        index += 1
    return create_group_stage(
        locked_ruleset.activity,
        stage_key=stage_key,
        name="第一轮分组合唱",
        operator=current_operator,
        roster_source=GroupStage.RosterSource.ALL_APPROVED,
        managed_by=GroupStage.ManagedBy.LIVE_2026,
        managed_by_version=locked_version,
        replaces_group_stage=predecessor,
        expected_binding_revision=locked_ruleset.binding_revision,
    )


@transaction.atomic
def bind_live_2026_group_stage(
    version: RulesetVersion,
    group_stage,
    *,
    operator,
    base_binding: str | None = None,
    base_binding_revision: int | None = None,
) -> ContestRuleset:
    """Bind (or re-bind) a frozen first-round GroupStage to this 2026 draft.

    The workbench owns the lifecycle; staff never edit ``group_stage_keys`` themselves.
    Re-binding changes the *draft's* editing surface only — a frozen version's own binding
    snapshot is immutable, so the running authority keeps its grouping.
    """

    from singer_contest.models import GroupStage

    current_operator = require_current_staff(operator)
    lock_activity_for_action(version.ruleset.activity)
    locked_ruleset = ContestRuleset.objects.select_for_update().get(pk=version.ruleset_id)
    locked_version = (
        RulesetVersion.objects.select_for_update().select_related("ruleset").get(pk=version.pk)
    )
    if locked_version.status != RulesetVersion.Status.DRAFT or not version_is_editable(
        locked_version
    ):
        raise ValidationError("只有最新草稿可以绑定第一轮分组。")
    stage = GroupStage.objects.get(pk=group_stage.pk)
    if stage.activity_id != locked_ruleset.activity_id:
        raise ValidationError("分组合唱赛段不属于当前活动。")
    if stage.status != GroupStage.Status.FROZEN:
        raise ValidationError("只有已冻结的分组合唱分组可以绑定。")

    binding = _snapshot_binding(locked_ruleset)
    if not _is_live_2026_binding(binding):
        raise ValidationError("当前赛制不是 2026 现场踢馆赛制。")
    first_round_key = live_2026_first_round_key(binding.get("live_challenge") or {})
    group_stage_keys = dict(binding.get("group_stage_keys") or {})
    existing = group_stage_keys.get(first_round_key)
    if str(existing) == str(stage.pk):
        return locked_ruleset
    group_stage_keys[first_round_key] = stage.pk
    binding["group_stage_keys"] = group_stage_keys
    updated = update_ruleset_binding(
        locked_ruleset,
        binding=binding,
        operator=current_operator,
        base_binding=base_binding,
        base_binding_revision=base_binding_revision,
    )
    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"RulesetVersion:{version.pk}",
        new_value=json.dumps(
            {
                "group_stage_id": stage.pk,
                "previous_group_stage_id": existing,
                "first_round_key": first_round_key,
            },
            ensure_ascii=False,
        ),
        note="bind_live_2026_group_stage",
    )
    return updated


def auto_bind_live_2026_group_stage(group_stage, operator):
    """Best-effort: a stage frozen through the ordinary group page joins the 2026 draft.

    A workbench stage belongs to the version that created it and remembers the binding it
    intended to replace. Auto-binding is a compare-and-swap against that intent: if the
    draft's binding changed in the meantime (another staff member explicitly chose a
    different stage), the freeze keeps the new stage selectable but never overwrites the
    newer choice. A generic stage may only fill an empty slot.
    """

    try:
        ruleset = ContestRuleset.objects.filter(activity_id=group_stage.activity_id).first()
        if ruleset is None or not _is_live_2026_binding(
            {"live_challenge": ruleset.live_challenge or {}}
        ):
            return None

        def _binding_state(version):
            binding = _snapshot_binding(version.ruleset)
            first_round_key = live_2026_first_round_key(binding.get("live_challenge") or {})
            existing = (binding.get("group_stage_keys") or {}).get(first_round_key)
            return first_round_key, existing

        if group_stage.managed_by_version_id is not None:
            version = (
                RulesetVersion.objects.filter(
                    pk=group_stage.managed_by_version_id,
                    status=RulesetVersion.Status.DRAFT,
                )
                .select_related("ruleset")
                .first()
            )
            if version is None or not version_is_editable(version):
                return None
            if version.ruleset.binding_revision != group_stage.expected_binding_revision:
                # The binding changed since this preview was created — even if it changed
                # back to the same stage id (A -> C -> A). A later explicit intent wins.
                return None
            _key, existing = _binding_state(version)
            actual = int(existing) if existing not in (None, "") else None
            if actual != group_stage.replaces_group_stage_id:
                # A newer explicit choice won; leave it alone.
                return None
            return bind_live_2026_group_stage(version, group_stage, operator=operator)

        # Legacy/generic stages have no owner intent. They may fill an empty first-round
        # slot on the newest editable 2026 draft, never replace an existing binding.
        for version in RulesetVersion.objects.filter(
            ruleset=ruleset, status=RulesetVersion.Status.DRAFT
        ).order_by("-version"):
            if not version_is_editable(version):
                continue
            _key, existing = _binding_state(version)
            if existing in (None, ""):
                return bind_live_2026_group_stage(version, group_stage, operator=operator)
            return None
    except (ValidationError, PermissionDenied):
        return None
    return None


@transaction.atomic
def clone_first_round_for_successor(ruleset: ContestRuleset, version: RulesetVersion, *, operator):
    """Copy the first round onto a new DRAFT round and rebind this version to it.

    The frozen authority owns the round it binds, so a successor that needs different seats
    cannot move that one. The way out — "create a round, rebind it, come back" — is four pages
    of work for what the operator thinks of as "change 10 to 8", and a reset button is worse
    than useless here: it destroys the running round's prepared data and the guard still
    refuses afterwards. This is the way out in one action.

    Configuration only. No entries, no scores, no snapshots come across; the new round is a
    draft that has never been prepared.
    """

    from singer_contest.models import ContestRound

    from .services import version_is_editable

    current_operator = require_current_staff(operator)
    lock_activity_for_action(ruleset.activity)
    locked_ruleset = ContestRuleset.objects.select_for_update().get(pk=ruleset.pk)
    locked_version = RulesetVersion.objects.select_for_update().get(pk=version.pk)
    if not version_is_editable(locked_version):
        raise PermissionDenied("只有该赛制的最新草稿可以建立后继第一轮。")

    source = _bound_first_round(locked_ruleset, lock=True)
    if source is None:
        raise ValidationError("当前赛制还没有绑定第一轮，请先在配置页保存一次。")
    if source.pk not in current_frozen_round_ids(locked_ruleset, excluding_version=locked_version):
        raise ValidationError("当前第一轮不属于正式赛制，直接在轮次页面修改即可，不需要复制。")

    # The seats come from the *binding*, not from the round being replaced: when the operator
    # has already saved 8, the binding says 8 while the old round still says 10, and the clone
    # should agree with where they are going rather than with where the authority still is.
    seat_count = live_challenge_counts_from_binding(_snapshot_binding(locked_ruleset)).seat_count
    next_sequence = (
        ContestRound.objects.filter(activity_id=locked_ruleset.activity_id).aggregate(
            max_sequence=Max("sequence")
        )["max_sequence"]
        or 0
    ) + 1
    with authority_write(CONTEST_ROUND_STATE):
        cloned = ContestRound.objects.create(
            activity_id=locked_ruleset.activity_id,
            round_type=source.round_type,
            sequence=next_sequence,
            name=f"{source.name or LIVE_2026_FIRST_ROUND_NAME}{FIRST_ROUND_CLONE_SUFFIX}",
            scoring_mode=source.scoring_mode,
            score_completion_mode=source.score_completion_mode,
            judge_count=source.judge_count,
            minimum_judge_count=source.minimum_judge_count,
            advance_count=seat_count,
            roster_source=source.roster_source,
            roster_source_stage=source.roster_source_stage,
            roster_source_challenge_session_id=source.roster_source_challenge_session_id,
            rubric=source.rubric,
            # Execution configuration, not just scoring configuration. A copy that fell back
            # to the model defaults would quietly change how the venue calls singers up.
            order_policy=source.order_policy,
            tie_order_policy=source.tie_order_policy,
            scheduled_at=source.scheduled_at,
            venue=source.venue,
        )

    current = _snapshot_binding(locked_ruleset)
    first_round_key = str(
        (locked_ruleset.live_challenge or {}).get("podium_first_round_key")
        or LIVE_2026_FIRST_ROUND_KEY
    )
    update_ruleset_binding(
        locked_ruleset,
        binding={
            **current,
            "round_keys": {**current["round_keys"], first_round_key: cloned.pk},
        },
        operator=current_operator,
    )
    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.OTHER,
        target=f"ContestRound:{cloned.pk}",
        new_value=json.dumps(
            {"cloned_from": source.pk, "first_round_key": first_round_key},
            ensure_ascii=False,
        ),
        note="clone_first_round_for_successor",
    )
    return cloned


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
    """Create the activity's ruleset from the 2026 built-in, pre-filled — once.

    "Pre-filled" is an *arrival* property, not a reset button. Clicking the built-in again on
    an activity that already runs the 2026 format must not write the built-in's 15/5/10 back
    over the operators' 12/4/8, and must not leave a second DRAFT claiming the same shared
    ``ContestRuleset`` binding surface — an older draft built on the new numbers is exactly
    the "v2 的 definition 还写着 10" state the freeze contract later refuses.

    So the preset is applied only when the ruleset does not carry the 2026 format yet; after
    that this returns to the draft that already exists, or issues the successor of the frozen
    version if that is all there is.
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
    already_formatted = (
        str((ruleset.live_challenge or {}).get("format_key") or "") == LIVE_CHALLENGE_FORMAT_KEY
    )

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
            "live_challenge": (
                dict(current.get("live_challenge") or {})
                if already_formatted
                else live_2026_binding_preset()
            ),
        },
        operator=current_operator,
    )

    version = _arriving_or_existing_draft(
        ruleset, template=template, operator=current_operator, reuse=already_formatted
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
                "live_challenge": ("kept" if already_formatted else live_2026_binding_preset()),
            },
            ensure_ascii=False,
        ),
        note=(
            "provision_live_2026_ruleset_reuse"
            if already_formatted
            else "provision_live_2026_ruleset"
        ),
    )
    return version


def _arriving_or_existing_draft(
    ruleset: ContestRuleset, *, template, operator, reuse: bool
) -> RulesetVersion:
    """The version the operator continues on: a new one only when the format first arrives."""

    if reuse:
        # The newest DRAFT, not the newest *draft*: a frozen successor makes every draft
        # beside it history, and continuing on one would edit state the authority has left.
        draft = editable_ruleset_version(ruleset)
        if draft is not None:
            return draft
        frozen = (
            ruleset.versions.filter(status=RulesetVersion.Status.FROZEN)
            .order_by("-version")
            .first()
        )
        # The successor of the running authority, not a fresh copy of the built-in: the
        # operators' numbers live in the frozen definition and must come across.
        return (
            supersede_ruleset_version(frozen, created_by=operator)
            if frozen is not None
            else create_ruleset_version(
                ruleset, definition=template.definition, created_by=operator
            )
        )
    return create_ruleset_version(ruleset, definition=template.definition, created_by=operator)
