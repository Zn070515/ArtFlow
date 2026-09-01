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

from common.authority import RULESET_FREEZE, authority_write
from common.models import AuditLog
from core.services import lock_activity_for_action
from django.contrib.auth import get_user_model
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
        "group_keys": dict(ruleset.group_keys or {}),
        "announcement_blocks": list(ruleset.announcement_blocks or []),
        "announcement_blocks_by_checkpoint": dict(ruleset.announcement_blocks_by_checkpoint or {}),
    }


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
            "group_keys": dict(ruleset.group_keys or {}),
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
    group_keys = _normalize_pk_map(binding.get("group_keys"), label="group_keys")
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

    return {
        "stage_key": str(binding.get("stage_key") or "").strip(),
        "round_keys": normalized_round_keys,
        "vote_keys": vote_keys,
        "group_keys": group_keys,
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
    locked = _lock_version_for_write(version)
    if locked.status == RulesetVersion.Status.FROZEN:
        raise PermissionDenied("已冻结赛制版本不可编辑。")
    if base_content_hash is not None and locked.content_hash != base_content_hash:
        raise ValidationError("赛制已被其他编辑修改，请刷新后重试。")
    parse_definition(definition)
    locked.definition = definition
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
    lock_activity_for_action(ruleset.activity)
    locked = ContestRuleset.objects.select_for_update().get(pk=ruleset.pk)
    if base_binding is not None and _binding_signature(locked) != base_binding:
        raise ValidationError("赛制绑定已被其他编辑修改，请刷新后重试。")
    normalized = validate_binding(locked, binding)
    locked.stage_key = normalized["stage_key"]
    locked.round_keys = normalized["round_keys"]
    locked.vote_keys = normalized["vote_keys"]
    locked.group_keys = normalized["group_keys"]
    locked.announcement_blocks = normalized["announcement_blocks"]
    locked.announcement_blocks_by_checkpoint = normalized["announcement_blocks_by_checkpoint"]
    locked.save(
        update_fields=[
            "stage_key",
            "round_keys",
            "vote_keys",
            "group_keys",
            "announcement_blocks",
            "announcement_blocks_by_checkpoint",
            "updated_at",
        ]
    )
    return locked


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
    entry_size = _scoped_entry_count(activity)

    round_ctx: dict[str, dict] = {}
    for rkey, rpk in round_keys.items():
        contest_round = ContestRound.objects.filter(pk=rpk, activity=activity).first()
        if contest_round is None:
            continue
        judge_count = contest_round.round_judges.count()
        entry_count = contest_round.entries.count()
        scope = "full" if entry_count and entry_size and entry_count >= entry_size else "subset"
        item: dict = {"judge_count": judge_count, "scope": scope}
        scale = _round_scale(contest_round)
        if scale:
            item["scale"] = scale
        round_ctx[rkey] = item

    votes = {}
    for source, vs_pk in (binding.get("vote_keys") or {}).items():
        vote = _vote_binding(vs_pk)
        if vote:
            votes[source] = vote

    groups = {}
    for by, rpk in (binding.get("group_keys") or {}).items():
        caps = list(_annotated_capacity(rpk, activity))
        if caps:
            groups[by] = {"capacity": caps}

    return {"entry_size": entry_size, "rounds": round_ctx, "votes": votes, "groups": groups}


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


def _vote_binding(vs_pk) -> dict:
    from voting.models import VoteSession

    vs = VoteSession.objects.filter(pk=vs_pk).first()
    if vs is None:
        return {}
    # M1-R9 (§一/三 "Vote/Score Source Truth"): a bound VoteSession yields RAW vote counts
    # (unit ``votes``), never a pre-normalized hundred-mark score. The loader
    # ``_source_vote_scores`` returns raw counts; there is no VoteScoringRule to convert
    # votes -> points yet. Declaring ``hundred + normalization`` here was the "lie" that
    # let a SCORE_COMPONENT audience vote mix raw counts into a weighted sum as if they
    # were already a 0-100 score. The compiler now rejects a SCORE_COMPONENT source with
    # unit ``votes`` (VOTE_SCORE_COMPONENT_RAW) until an explicit conversion rule exists.
    # Runtime vote readiness (ballots cast / locked / result ready) remains a resolver HOLD
    # condition, never a Freeze gate — so no ``result_ready`` fact is produced here.
    return {"scale": "votes"}


def _annotated_capacity(rpk, activity):
    from django.db.models import Count
    from singer_contest.models import PerformanceGroup

    return (
        PerformanceGroup.objects.filter(round_id=rpk, activity=activity)
        .annotate(n=Count("performances"))
        .values_list("n", flat=True)
    )


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
    current_operator = get_user_model().objects.get(pk=operator.pk)
    if not current_operator.is_active or not current_operator.is_admin:
        raise PermissionDenied("只有管理员可以核定冻结赛制。")
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
    bound_context = build_bound_context(locked, normalized_binding)
    report, plan = compile_definition(locked.definition, context=bound_context, bound=True)
    if not report.passes():
        raise RulesetInvalidError(report, plan)
    assert plan is not None

    old_status = "draft"
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
        created_by=created_by,
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
        created_by=created_by,
    )
