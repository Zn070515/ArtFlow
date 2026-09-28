"""Freeze service for a DRAFT :class:`RulesetVersion` (§8.2, §16).

A ruleset becomes authoritative only through a *freeze*: the DRAFT version is
re-compiled, refused if the compiler reports any ERROR, and only then set to
``status=FROZEN`` with a frozen_by/frozen_at stamp and its execution plan
persisted. The bindings (round_keys / stage_key / announcement_blocks) are
snapshotted onto the version, so the frozen version is self-authoritative: the
runtime never re-reads the mutable ``ContestRuleset`` binding fields. The prior
current version (which is FROZEN) is demoted so the one-current partial unique
constraint holds and never violates the queryset's immutable guard — that demotion
goes through :class:`RulesetVersion._base_manager`.

The transaction is the only authority: admin does not require phase-gating (ruleset
config is set pre-contest), but requires the activity to be unlocked and the operator
to be an effective admin. Every freeze writes a :class:`~common.models.AuditLog`.
"""

from __future__ import annotations

import hashlib
import json

from accounts.services import require_current_admin, require_current_staff
from common.authority import RULESET_FREEZE, authority_write
from common.models import AuditLog
from core.models import Activity
from core.services import lock_activity_for_action
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.utils import timezone

from .compiler import ExecutionPlan, ValidationReport, compile_definition
from .models import ContestRuleset, RulesetVersion
from .schema import content_hash, parse_definition


class RulesetInvalidError(Exception):
    """The definition failed compilation; freezing must abort."""

    def __init__(self, report: ValidationReport, plan: ExecutionPlan | None):
        super().__init__("Ruleset definition is invalid; freeze aborted.")
        self.report = report
        self.plan = plan


def _demote_prior_current(version: RulesetVersion) -> None:
    """Drop the current flag from the previously-current FROZEN version.

    Uses the *base* manager (not the guarded ``objects`` manager) so the demotion
    does not trip the frozen-immutability guard — the demotion changes ``is_current``
    (which the immutable_fields list includes), so the queryset guard would otherwise
    raise. Only valid inside the freeze transaction.
    """
    RulesetVersion._base_manager.filter(ruleset_id=version.ruleset_id).exclude(
        pk=version.pk
    ).filter(is_current=True).update(is_current=False)


def _snapshot_binding(ruleset: ContestRuleset) -> dict:
    """Read the binding off a ruleset at freeze time (the editable input surface)."""
    return {
        "stage_key": ruleset.stage_key or "",
        "round_keys": dict(ruleset.round_keys or {}),
        "vote_keys": dict(ruleset.vote_keys or {}),
        "vote_scoring_rule_keys": dict(ruleset.vote_scoring_rule_keys or {}),
        "group_keys": dict(ruleset.group_keys or {}),
        "audience_keys": dict(ruleset.audience_keys or {}),
        "announcement_blocks": list(ruleset.announcement_blocks or []),
        "announcement_blocks_by_checkpoint": dict(ruleset.announcement_blocks_by_checkpoint or {}),
    }


def vote_scoring_binding_snapshot(rule_keys) -> dict:
    """The canonical frozen form of the ``{vote_source: rule pk}`` conversion binding.

    Freezing records the conversion's *identity and meaning* — rule id, mode and output
    scale — so a replay (and the staff verification panel) never has to ask the database
    which rule the session "has now". Refuses a rule that does not exist.
    """
    from voting.models import VoteScoringRule

    normalized = _normalize_pk_map(rule_keys, label="vote_scoring_rule_keys")
    if not normalized:
        return {}
    rules = {rule.pk: rule for rule in VoteScoringRule.objects.filter(pk__in=normalized.values())}
    snapshot: dict[str, dict] = {}
    for source, rule_pk in normalized.items():
        rule = rules.get(rule_pk)
        if rule is None:
            raise ValidationError(f"成绩换算规则不存在：{rule_pk}")
        snapshot[str(source)] = {
            "rule": rule.pk,
            "mode": rule.mode,
            "scale": rule.output_scale,
        }
    return snapshot


def _binding_signature(ruleset: ContestRuleset) -> str:
    """Canonical signature of a ruleset's editable binding surface.

    Used for stale-write detection in :func:`update_ruleset_binding`: a staff member's
    form carries the signature they loaded; if the committed surface changed since, the
    save is refused as a concurrent-edit conflict rather than silently overwriting.
    """
    return json.dumps(
        {
            "stage_key": ruleset.stage_key or "",
            "round_keys": dict(ruleset.round_keys or {}),
            "vote_keys": dict(ruleset.vote_keys or {}),
            "vote_scoring_rule_keys": dict(ruleset.vote_scoring_rule_keys or {}),
            "group_keys": dict(ruleset.group_keys or {}),
            "audience_keys": dict(ruleset.audience_keys or {}),
            "announcement_blocks": list(ruleset.announcement_blocks or []),
            "announcement_blocks_by_checkpoint": dict(
                ruleset.announcement_blocks_by_checkpoint or {}
            ),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _authority_hash(version: RulesetVersion) -> str:
    """Digest of the full authoritative surface (definition + frozen binding + plan).

    Unlike :func:`ruleset.schema.content_hash` (definition-only), this captures the
    freeze-time binding snapshot too, so two versions with identical definitions but
    different bindings hash differently. The StageResult audit identity uses it.
    """
    if version.execution_plan:
        try:
            plan_version = json.loads(version.execution_plan).get("plan_version", 0)
        except ValueError:
            plan_version = 0
    else:
        plan_version = 0
    digest = (
        content_hash(version.definition)
        + "|"
        + json.dumps(
            version.binding or {},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "|"
        + str(plan_version)
    )
    return hashlib.sha256(digest.encode("utf-8")).hexdigest()


def _normalize_pk_map(raw, *, label):
    """Normalize a ``{str: int}`` binding map, rejecting malformed/empty ids."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValidationError(f"{label} 必须是 {{key: id}} 映射。")
    out: dict[str, int] = {}
    for key, rid in raw.items():
        if rid in ("", None):
            continue
        try:
            out[str(key)] = int(rid)
        except (TypeError, ValueError):
            raise ValidationError(f"{label}['{key}'] 必须是 id，got {rid!r}。")
    return out


def _normalize_string_map(raw, *, label):
    """Normalize a ``{str: str}`` binding map (e.g. audience_keys), rejecting empties."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValidationError(f"{label} 必须是 {{key: value}} 映射。")
    out: dict[str, str] = {}
    for key, value in raw.items():
        value = str(value).strip() if value is not None else ""
        if not value:
            continue
        out[str(key)] = value
    return out


def validate_binding(ruleset: ContestRuleset, binding: dict | None) -> dict:
    """Normalize and validate a binding snapshot against the ruleset's activity.

    Only round/vote/group keys that resolve to a ``ContestRound`` / ``VoteSession`` /
    ``ContestRound`` owned by the same activity are accepted (a binding may only reference
    its own resources). Returns a normalized dict with ``{stage_key, round_keys, vote_keys,
    group_keys, announcement_blocks}``.
    """
    binding = dict(binding or {})
    normalized_round_keys = _normalize_pk_map(binding.get("round_keys"), label="round_keys")
    vote_keys = _normalize_pk_map(binding.get("vote_keys"), label="vote_keys")
    scoring_rule_keys = _normalize_pk_map(
        binding.get("vote_scoring_rule_keys"), label="vote_scoring_rule_keys"
    )
    group_keys = _normalize_pk_map(binding.get("group_keys"), label="group_keys")
    audience_keys = _normalize_string_map(binding.get("audience_keys"), label="audience_keys")
    announcement_blocks = binding.get("announcement_blocks") or []
    if not isinstance(announcement_blocks, list):
        raise ValidationError("announcement_blocks 必须是列表。")
    blocks_by_checkpoint = binding.get("announcement_blocks_by_checkpoint") or {}
    if not isinstance(blocks_by_checkpoint, dict):
        raise ValidationError(
            "announcement_blocks_by_checkpoint 必须是 {checkpoint: [blocks]} 映射。"
        )
    for cp_key, cp_blocks in blocks_by_checkpoint.items():
        if not isinstance(cp_blocks, list):
            raise ValidationError(f"announcement_blocks_by_checkpoint['{cp_key}'] 必须是列表。")

    from singer_contest.models import ContestRound
    from voting.models import VoteSession

    round_ids = list(normalized_round_keys.values())
    owned_rounds = {
        r.pk for r in ContestRound.objects.filter(pk__in=round_ids, activity=ruleset.activity_id)
    }
    missing_rounds = [rid for rid in round_ids if rid not in owned_rounds]
    if missing_rounds:
        raise ValidationError(f"赛制绑定的比赛轮次不属于该活动：{missing_rounds}")

    vote_ids = list(vote_keys.values())
    owned_votes = {
        v.pk for v in VoteSession.objects.filter(pk__in=vote_ids, activity=ruleset.activity_id)
    }
    missing_votes = [vid for vid in vote_ids if vid not in owned_votes]
    if missing_votes:
        raise ValidationError(f"赛制绑定的投票会话不属于该活动：{missing_votes}")

    group_ids = list(group_keys.values())
    owned_groups = {
        r.pk for r in ContestRound.objects.filter(pk__in=group_ids, activity=ruleset.activity_id)
    }
    missing_groups = [gid for gid in group_ids if gid not in owned_groups]
    if missing_groups:
        raise ValidationError(f"赛制绑定的分组成员轮次不属于该活动：{missing_groups}")

    # §6.1: a conversion rule is only meaningful for the vote source it converts, so the
    # binding must name an existing rule of exactly that bound session.
    if scoring_rule_keys:
        from voting.models import VoteScoringRule

        rules = {
            rule.pk: rule
            for rule in VoteScoringRule.objects.filter(pk__in=scoring_rule_keys.values())
        }
        for source, rule_pk in scoring_rule_keys.items():
            rule = rules.get(rule_pk)
            if rule is None:
                raise ValidationError(f"赛制绑定的成绩换算规则不存在：{rule_pk}")
            bound_session = vote_keys.get(source)
            if bound_session is None:
                raise ValidationError(f"成绩换算规则 {rule_pk} 未绑定对应的投票源 {source}。")
            if rule.vote_session_id != bound_session:
                raise ValidationError(f"成绩换算规则 {rule_pk} 不属于投票 {bound_session}。")

    # A source key must not bind as both a raw-count vote and a staff-entered audience
    # score: `_combined_vote_scores` would silently let audience overwrite the counts, and
    # `_stage_consumed_facts` already splits them — so reject the ambiguity at freeze time.
    overlap = set(vote_keys) & set(audience_keys)
    if overlap:
        raise ValidationError(f"观众分与投票键重复绑定：{sorted(overlap)}")

    return {
        "stage_key": str(binding.get("stage_key") or "").strip(),
        "round_keys": normalized_round_keys,
        "vote_keys": vote_keys,
        "vote_scoring_rule_keys": scoring_rule_keys,
        "group_keys": group_keys,
        "audience_keys": audience_keys,
        "announcement_blocks": announcement_blocks,
        "announcement_blocks_by_checkpoint": dict(blocks_by_checkpoint),
    }


def _lock_version_for_write(version: RulesetVersion) -> RulesetVersion:
    """Activity → ContestRuleset → RulesetVersion, re-reading the child under the lock.

    M0 lock-order: a child write must lock the Activity first, then re-read the owned
    aggregates, so a concurrent edit cannot operate over a stale in-memory object.
    """
    lock_activity_for_action(version.ruleset.activity)
    ContestRuleset.objects.select_for_update().get(pk=version.ruleset_id)
    return (
        RulesetVersion.objects.select_for_update()
        .select_related("ruleset__activity")
        .get(pk=version.pk)
    )


@transaction.atomic
def update_ruleset_definition(
    version: RulesetVersion, *, definition: str, operator, base_content_hash: str | None = None
) -> RulesetVersion:
    """Persist a Draft definition edit under the Activity-first lock.

    Re-reads the version after locking (a second staff member's concurrent save cannot be
    silently overwritten), refuses a write to a FROZEN version, and — when
    ``base_content_hash`` is supplied — rejects a save whose editor started from a stale
    definition (the 409-contract for concurrent editing). Returns the locked version.
    """
    require_current_staff(operator)
    locked = _lock_version_for_write(version)
    if locked.status == RulesetVersion.Status.FROZEN:
        raise PermissionDenied("已冻结赛制版本不可编辑。")
    if base_content_hash is not None and locked.content_hash != base_content_hash:
        raise ValidationError("赛制已被其他编辑修改，请刷新后重试。")
    parse_definition(definition)
    locked.definition = definition
    locked.save(update_fields=["definition"])
    return locked


# The definition root's operator-editable sections. Each editor owns exactly one of them;
# replacing the whole document is reserved for the advanced JSON editor, which goes through
# ``update_ruleset_definition``.
DEFINITION_SECTIONS: tuple[str, ...] = ("nodes", "checkpoints", "context", "questionnaire")


@transaction.atomic
def update_ruleset_definition_section(
    version: RulesetVersion,
    *,
    section: str,
    value,
    operator,
    base_content_hash: str | None = None,
) -> RulesetVersion:
    """Replace one top-level ``definition`` section, leaving every sibling untouched.

    The root is a document, not a node list: ``checkpoints`` and ``context`` are already
    written beside ``nodes``, and the Ruleset-driven Questionnaire phase adds
    ``questionnaire`` next to them. An editor that rebuilds the whole root from the one
    section it edits deletes the others on every save — so each editor patches its own
    section through here and every sibling is handed back byte-identical.

    The version is re-read under the Activity-first lock, so the patch applies to the root
    as it exists at write time rather than to a document the caller loaded earlier.
    ``base_content_hash`` carries the same stale-editor contract as
    :func:`update_ruleset_definition`, and the complete document is re-validated before the
    save, so a section patch can never persist a graph that ``parse_definition`` rejects.
    """
    require_current_staff(operator)
    if section not in DEFINITION_SECTIONS:
        raise ValidationError(f"未知的 definition section：{section!r}")
    locked = _lock_version_for_write(version)
    if locked.status == RulesetVersion.Status.FROZEN:
        raise PermissionDenied("已冻结赛制版本不可编辑。")
    if base_content_hash is not None and locked.content_hash != base_content_hash:
        raise ValidationError("赛制已被其他编辑修改，请刷新后重试。")
    try:
        root = json.loads(locked.definition)
    except (TypeError, ValueError) as exc:
        raise ValidationError("赛制定义不是合法 JSON，无法按 section 保存。") from exc
    if not isinstance(root, dict):
        raise ValidationError("赛制定义的根必须是对象。")
    root[section] = value
    parse_definition(root)
    locked.definition = json.dumps(root, ensure_ascii=False)
    locked.save(update_fields=["definition"])
    return locked


@transaction.atomic
def update_ruleset_binding(
    ruleset: ContestRuleset, *, binding: dict, operator, base_binding: str | None = None
) -> ContestRuleset:
    """Persist a ContestRuleset binding edit under the Activity-first lock.

    Re-reads the ruleset after locking, validates/normalizes the binding, and rejects a
    save whose editor started from a stale binding surface (``base_binding`` signature).
    Does not touch the version: the snapshot runs at freeze time.
    """
    require_current_staff(operator)
    lock_activity_for_action(ruleset.activity)
    locked = ContestRuleset.objects.select_for_update().get(pk=ruleset.pk)
    if base_binding is not None and _binding_signature(locked) != base_binding:
        raise ValidationError("赛制绑定已被其他编辑修改，请刷新后重试。")
    normalized = validate_binding(locked, binding)
    locked.stage_key = normalized["stage_key"]
    locked.round_keys = normalized["round_keys"]
    locked.vote_keys = normalized["vote_keys"]
    locked.vote_scoring_rule_keys = normalized["vote_scoring_rule_keys"]
    locked.group_keys = normalized["group_keys"]
    locked.audience_keys = normalized["audience_keys"]
    locked.announcement_blocks = normalized["announcement_blocks"]
    locked.announcement_blocks_by_checkpoint = normalized["announcement_blocks_by_checkpoint"]
    locked.save(
        update_fields=[
            "stage_key",
            "round_keys",
            "vote_keys",
            "vote_scoring_rule_keys",
            "group_keys",
            "audience_keys",
            "announcement_blocks",
            "announcement_blocks_by_checkpoint",
            "updated_at",
        ]
    )
    return locked


# Phases in which the approved-singer roster is settled. Before these the roster genuinely
# does not exist yet, so every fact derived from it is UNKNOWN rather than zero — which is
# what lets a ruleset be confirmed before registration opens (see
# :func:`validate_ruleset_runtime_readiness`).
ROSTER_FINAL_PHASES = frozenset(
    {
        Activity.Phase.TESTING,  # a rehearsal runs on an already-materialised roster
        Activity.Phase.REHEARSAL,
        Activity.Phase.LIVE,
        Activity.Phase.RESULTS_PENDING,
        Activity.Phase.RESULTS_PUBLISHED,
        Activity.Phase.ARCHIVED,
    }
)


def entry_roster_is_final(activity) -> bool:
    """Whether the approved-singer roster is settled enough to prove roster facts."""
    return activity.phase in ROSTER_FINAL_PHASES


def current_frozen_version(activity) -> RulesetVersion | None:
    """The activity's current official FROZEN ruleset authority, if it has one."""
    return (
        RulesetVersion._base_manager.filter(
            ruleset__activity=activity,
            is_current=True,
            status=RulesetVersion.Status.FROZEN,
        )
        .order_by("-pk")
        .first()
    )


def require_runtime_readiness(activity) -> ValidationReport | None:
    """The unified runtime boundary for every "start running the contest" entry point.

    A ruleset is confirmed before registration opens, so the facts that depend on the
    final roster are DEFERRED at Freeze and proven here — the last moment before they
    become load-bearing. Returns ``None`` when the activity has no current FROZEN
    authority (those call sites already refuse to run without one); raises otherwise.

    Attached at :func:`singer_contest.services.prepare_round` (start scoring a round) and
    :func:`voting.services.open_vote_session` (start collecting ballots) — the two points
    that actually begin execution. It is deliberately *not* attached to
    ``maybe_resolve_checkpoints``: that is a result-publishing step downstream of both,
    it runs after every onsite input batch, and a full bound compile per batch is a heavy
    price on the hottest path. The rounds whose results it publishes were already gated
    when they were prepared.
    """
    version = current_frozen_version(activity)
    if version is None:
        return None
    return validate_ruleset_runtime_readiness(version)


def build_bound_context(version: RulesetVersion, binding: dict) -> dict:
    """Construct the §39 bound freeze context from the DB for a ContestRuleset.

    Unlike a template (which legitimately has no real entities and may WARN), a bound
    activity freeze must prove every verifiable fact or fail. ``entry_size`` is the
    scoped approved-singer count; each bound round contributes its real ``judge_count``,
    a ``scope`` ("full" when the round's RoundEntries cover the entry roster, else
    "subset"), and a ``scale`` derived from its rubric's aggregate criterion maximum;
    each vote source contributes its CONFIG ``scale``/``normalization`` (never a runtime
    ``result_ready`` — 0 ballots is a freeze-legal pre-contest state); each group
    partition contributes per-group ``capacity``. Facts the DB cannot supply are left
    unset so the bound compiler escalates the corresponding "unverifiable" WARN to a
    hard ERROR and refuses the freeze instead of inventing a value.
    """
    from singer_contest.models import ContestRound

    activity = version.ruleset.activity
    round_keys = binding.get("round_keys") or {}
    roster_final = entry_roster_is_final(activity)
    entry_size = _scoped_entry_count(activity) if roster_final else None

    round_ctx: dict[str, dict] = {}
    for rkey, rpk in round_keys.items():
        contest_round = ContestRound.objects.filter(pk=rpk, activity=activity).first()
        if contest_round is None:
            continue
        judge_count = contest_round.round_judges.count()
        item: dict = {"judge_count": judge_count}
        if roster_final:
            entry_count = contest_round.entries.count()
            item["scope"] = (
                "full" if entry_count and entry_size and entry_count >= entry_size else "subset"
            )
        scale = _round_scale(contest_round)
        if scale:
            item["scale"] = scale
        round_ctx[rkey] = item

    # §6.2: a bound session only reports a hundred-mark score when the binding names the
    # VoteScoringRule that converts it; a purpose alone never implies a conversion.
    scoring_rules = binding.get("vote_scoring_rule_keys") or {}
    votes = {}
    for source, vs_pk in (binding.get("vote_keys") or {}).items():
        vote = _vote_binding(vs_pk, scoring_rules.get(source), roster_final=roster_final)
        if vote:
            votes[source] = vote
    for source, _set_name in (binding.get("audience_keys") or {}).items():
        # Audience scores are staff-entered 0-100 values (not raw vote counts), so they
        # bind at a hundred scale for the compiler's scale-truth check.
        votes[source] = {"scale": "hundred"}

    groups = {}
    for by, rpk in (binding.get("group_keys") or {}).items():
        caps = list(_annotated_capacity(rpk, activity))
        if caps:
            groups[by] = {"capacity": caps}

    return {
        "entry_roster_final": roster_final,
        "entry_size": entry_size,
        "entry_candidates": _entry_candidates(version, activity) if roster_final else None,
        "rounds": round_ctx,
        "votes": votes,
        "groups": groups,
    }


def _entry_candidates(version, activity) -> list[str]:
    """The entry roster's candidate ids, exactly as the runtime resolver loads them.

    §7.3 needs the real pool identity (not just its size) to refuse a score-component vote
    whose roster drifted from the roster the stage actually scores. Read through the same
    helper the resolver uses so a freeze-time comparison cannot disagree with runtime.
    """
    from singer_contest.services import _stage_entry_roster

    return [str(pk) for pk in _stage_entry_roster(version, activity, {})]


def _scoped_entry_count(activity) -> int:
    from singer_contest.models import SingerRegistration

    return SingerRegistration.objects.filter(
        activity=activity, pre_status=SingerRegistration.PreStatus.APPROVED
    ).count()


def _round_scale(contest_round) -> str | None:
    rubric_id = getattr(contest_round, "rubric_id", None)
    if rubric_id is None:
        return None
    from decimal import Decimal

    from django.db.models import Sum
    from singer_contest.models import ScoringRubric

    total = ScoringRubric.objects.filter(pk=rubric_id).aggregate(s=Sum("criteria__max_score"))["s"]
    if total is None:
        return None
    # M1-R9 (§25 "不要继续用 ten/hundred"): a rubric declares a numeric score_max, not a
    # coarse "hundred"/"ten" bucket. Summing the criteria gives the true sheet maximum, so
    # a 50-mark sheet is "50", a 10-mark sheet is "10", and a 100-mark sheet is "100".
    # The old "non-100 is ten" collapsed 50/30/20/10 into one bucket and let a 50-mark
    # sheet be direct-summed with a 10-mark sheet as if the units matched.
    return str(int(Decimal(total)))


def _vote_binding(vs_pk, rule_snapshot: dict | None = None, *, roster_final: bool = True) -> dict:
    """The bound vote facts a freeze compiles against.

    Without an explicitly bound conversion rule a session yields RAW vote counts (unit
    ``votes``), never a pre-normalized hundred-mark score: the compiler rejects a
    SCORE_COMPONENT source in that state (``VOTE_SCORE_COMPONENT_RAW``). With a bound rule
    the conversion's *meaning* comes from the frozen snapshot (mode + output scale), so the
    rule's current row is never consulted at replay. Candidate ids ride along for the
    §7.3 roster-equality gate.

    Runtime vote readiness (ballots cast / locked / result ready) remains a resolver HOLD
    condition, never a Freeze gate — so no ``result_ready`` fact is produced here.
    """
    from voting.models import VoteOption, VoteSession

    vs = VoteSession.objects.filter(pk=vs_pk).first()
    if vs is None:
        return {}
    binding = {
        "purpose": vs.purpose,
        "requires_ticket": vs.requires_ticket,
    }
    if roster_final:
        binding["candidates"] = [
            str(singer_id)
            for singer_id in VoteOption.objects.filter(vote_session_id=vs_pk)
            .order_by("pk")
            .values_list("singer_id", flat=True)
        ]
    if rule_snapshot:
        binding["scale"] = rule_snapshot.get("scale") or "hundred"
        binding["conversion"] = rule_snapshot.get("mode")
        binding["scoring_rule"] = rule_snapshot.get("rule")
    else:
        binding["scale"] = "votes"
    return binding


def _annotated_capacity(rpk, activity):
    from django.db.models import Count
    from singer_contest.models import PerformanceGroup

    return (
        PerformanceGroup.objects.filter(round_id=rpk, activity=activity)
        .annotate(n=Count("performances"))
        .values_list("n", flat=True)
    )


def validate_ruleset_runtime_readiness(version: RulesetVersion) -> ValidationReport:
    """Re-run a frozen ruleset's deferred roster checks against the settled roster.

    A ruleset may be frozen before registration opens: its *definition* is provable then,
    its *roster* is not. Every check that had to wait is recorded as a DEFERRED issue at
    Freeze time and re-run here, where the roster is finally the authority. This is the
    last gate before the competition runs, so it fails closed in both directions — a roster
    that still does not exist is refused outright rather than read as an empty pass, and a
    roster that cannot support the frozen plan raises :class:`RulesetInvalidError`.
    """
    if version.status != RulesetVersion.Status.FROZEN:
        raise ValidationError("只有已冻结赛制可以核定运行时名单。")
    activity = version.ruleset.activity
    if not entry_roster_is_final(activity):
        raise ValidationError("报名名单尚未确定，无法核定运行时名单。")
    context = build_bound_context(version, version.binding or {})
    report, plan = compile_definition(version.definition, context=context, bound=True)
    if not report.passes():
        raise RulesetInvalidError(report, plan)
    return report


@transaction.atomic
def freeze_ruleset_version(
    version: RulesetVersion,
    operator,
    *,
    binding: dict | None = None,
) -> RulesetVersion:
    """Freeze a DRAFT ContestRuleset version, always at the *bound* activity level.

    ``binding`` (optional) supplies the editable input surface; when omitted it is
    snapshotted verbatim from the ruleset. Unlike a template freeze (bound=False), a
    ContestRuleset freeze builds the real context from the DB via :func:`build_bound_context`
    and compiles with ``bound=True``, so any fact the compiler could only WARN about as
    "unverifiable until bound" becomes an ERROR and aborts the freeze. Raises
    :class:`PermissionDenied` if the operator is not an effective admin or the activity is
    locked; :class:`ValidationError` if the version is already frozen or the binding is
    invalid; :class:`RulesetInvalidError` if compilation reports any ERROR.
    """
    locked = _lock_version_for_write(version)
    current_operator = require_current_admin(operator)
    if locked.status == RulesetVersion.Status.FROZEN:
        raise ValidationError("该赛制版本已冻结。")

    # M1-R9 (§五): a normal successor Freeze demotes the running FROZEN authority. That is
    # only legal while no result grounded in it is CONFIRMED — finality means a confirmed
    # handcard must stay attributable to the authority it was frozen under. If the current
    # version already has a CONFIRMED StageResult, reject the re-freeze (the operator must
    # first unlock the result via :func:`unlock_stage_result` to release finality).
    from singer_contest.models import StageResult

    prior = (
        RulesetVersion._base_manager.filter(ruleset_id=locked.ruleset_id)
        .exclude(pk=locked.pk)
        .filter(is_current=True, status=RulesetVersion.Status.FROZEN)
        .first()
    )
    if (
        prior is not None
        and prior.stage_results.filter(status=StageResult.Status.CONFIRMED).exists()
    ):
        raise ValidationError("当前冻结赛制已核定赛段结果，不可生成后继赛制版本。")

    freeze_binding = _snapshot_binding(locked.ruleset) if binding is None else binding
    normalized_binding = validate_binding(locked.ruleset, freeze_binding)
    # §6.1: freeze the conversion authority itself (rule id + mode + output scale). The
    # editable surface only names the rule; the snapshot records what it meant, so a replay
    # reads the frozen identity instead of asking the DB which rule the session "has now".
    normalized_binding["vote_scoring_rule_keys"] = vote_scoring_binding_snapshot(
        normalized_binding.get("vote_scoring_rule_keys")
    )
    bound_context = build_bound_context(locked, normalized_binding)
    report, plan = compile_definition(locked.definition, context=bound_context, bound=True)
    if not report.passes():
        raise RulesetInvalidError(report, plan)
    assert plan is not None

    old_status = "draft"
    with authority_write(RULESET_FREEZE):
        _demote_prior_current(locked)
    locked.status = RulesetVersion.Status.FROZEN
    locked.frozen_by = current_operator
    locked.frozen_at = timezone.now()
    locked.is_current = True
    locked.execution_plan = json.dumps(plan.to_dict(), ensure_ascii=False)
    locked.binding = normalized_binding
    locked.authority_hash = _authority_hash(locked)
    with authority_write(RULESET_FREEZE):
        locked.save(
            update_fields=[
                "status",
                "frozen_by",
                "frozen_at",
                "is_current",
                "execution_plan",
                "binding",
                "authority_hash",
            ],
        )
    AuditLog.objects.create(
        operator=current_operator,
        action_type=AuditLog.ActionType.FINALIZE_RULESET,
        target=f"RulesetVersion:{locked.pk}",
        old_value=json.dumps({"status": old_status}, ensure_ascii=False),
        new_value=json.dumps(
            {
                "status": RulesetVersion.Status.FROZEN,
                "content_hash": locked.content_hash,
                "authority_hash": locked.authority_hash,
                "binding": normalized_binding,
                "error_count": 0,
            },
            ensure_ascii=False,
        ),
    )
    return locked


@transaction.atomic
def supersede_ruleset_version(
    version: RulesetVersion, *, created_by, definition: str | None = None
) -> RulesetVersion:
    """Create the next DRAFT version that supersedes a FROZEN one (the editing target).

    §M1-R8: ``is_current`` means *current official authority*, so issuing a Draft editor
    never demotes the running FROZEN authority — the prior FROZEN stays ``is_current``
    until the successor is itself frozen (at which point :func:`freeze_ruleset_version`
    atomically flips authority). The editor finds this successor by ``status=DRAFT``, not
    by ``is_current``. Freezing the successor later re-promotes it to current FROZEN.
    """
    current_operator = require_current_staff(created_by)
    lock_activity_for_action(version.ruleset.activity)
    ContestRuleset.objects.select_for_update().get(pk=version.ruleset_id)
    locked = (
        RulesetVersion.objects.select_for_update()
        .select_related("ruleset__activity")
        .get(pk=version.pk)
    )
    if locked.status != RulesetVersion.Status.FROZEN:
        raise ValidationError("只有已冻结的赛制版本可以被继任覆盖。")
    last = locked.ruleset.versions.order_by("-version").values_list("version", flat=True).first()
    next_version = (last or 0) + 1
    return RulesetVersion.objects.create(
        ruleset=locked.ruleset,
        version=next_version,
        definition=definition if definition is not None else locked.definition,
        binding=locked.binding,
        is_current=False,
        status=RulesetVersion.Status.DRAFT,
        created_by=current_operator,
    )


@transaction.atomic
def create_ruleset_version(
    ruleset: ContestRuleset, *, definition: str, created_by, binding: dict | None = None
) -> RulesetVersion:
    """Create the next version on a ruleset, preserving the one-current invariant.

    §M1-R8: ``is_current`` means *current official authority (FROZEN)*, so a new DRAFT is
    never issued as current and never demotes a running FROZEN authority. An activity with
    only DRAFTs has no current authority until one is frozen (``freeze_ruleset_version``
    then flips authority). Used by ruleset creation and template clones; numbering uses
    ``max(version)+1`` to avoid the unique ``(ruleset, version)`` collision when a ruleset
    — or an activity's ruleset — is cloned repeatedly.
    """
    current_operator = require_current_staff(created_by)
    lock_activity_for_action(ruleset.activity)
    locked = ContestRuleset.objects.select_for_update().get(pk=ruleset.pk)
    last = locked.versions.order_by("-version").values_list("version", flat=True).first()
    next_version = (last or 0) + 1
    return RulesetVersion.objects.create(
        ruleset=locked,
        version=next_version,
        definition=definition,
        binding=dict(binding or {}),
        is_current=False,
        created_by=current_operator,
    )
