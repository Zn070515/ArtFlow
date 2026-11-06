"""Run a golden fixture against the v1 Django implementation.

The fixtures are implementation-agnostic. This module is the v1 side of the
contract: each adapter maps the fixture's stable facts to v1 rows, invokes the
real authority service for a step, and returns the events/read model the
fixture asks about. A rejected step raises :class:`GoldenRejected` with the
fixture's reason code, so the same runner will work for Plus later.
"""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    RULESET_FREEZE,
    STAGE_RESULT_CONFIRM,
    STAGE_RESULT_RESOLVE,
    authority_write,
)
from core.models import Activity
from django.core.exceptions import ValidationError
from django.utils import timezone
from public_portal.models import PublicPost, ResultRelease
from public_portal.services import (
    release_result_post,
    revoke_result_release,
)
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.models import (
    SingerRegistration,
    StageAwardDecision,
    StageDecision,
    StageResult,
)
from singer_contest.services import unlock_stage_result

RULESET_HASH = "a" * 64


class GoldenRejected(Exception):
    """A command the fixture expects to be refused."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class ResultReleaseAdapter:
    """v1 adapter for `result-release-lifecycle.json`."""

    fixture_id = "result-release-lifecycle"

    def __init__(self, facts: dict) -> None:
        self.facts = facts
        self.admin: User | None = None
        self.staff: User | None = None
        self.participant_b: User | None = None
        self.activity: Activity | None = None
        self.stage: StageResult | None = None
        self.post: PublicPost | None = None

    def setup(self) -> None:
        facts = self.facts
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin = User.objects.create_user(
                username="golden-release-admin",
                password="pass",
                role=User.Role.ADMIN,
            )
            self.staff = User.objects.create_user(
                username="golden-release-staff",
                password="pass",
                role=User.Role.STAFF,
            )
            self.participant_b = User.objects.create_user(
                username="golden-release-participant-b",
                password="pass",
                role=User.Role.PARTICIPANT,
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title=facts["activity"]["title"],
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.RESULTS_PUBLISHED,
                is_test_mode=False,
            )
        ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="Golden release ruleset",
            stage_key="final_podium",
        )
        with authority_write(RULESET_FREEZE):
            version = RulesetVersion.objects.create(
                ruleset=ruleset,
                version=1,
                definition='{"schema_version": 1, "nodes": [{"key": "roster", "type": "ROSTER"}]}',
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                authority_hash=RULESET_HASH,
            )
        singer_a = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.staff,
            name="Golden Singer A",
            student_id="golden-001",
            college="Arts",
            class_name="Class 1",
            phone="13800000000",
            song_name="",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        singer_b = SingerRegistration.objects.create(
            activity=self.activity,
            user=self.participant_b,
            name="Golden Singer B",
            student_id="golden-002",
            college="Arts",
            class_name="Class 1",
            phone="13800000001",
            song_name="",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        with authority_write(STAGE_RESULT_RESOLVE):
            self.stage = StageResult.objects.create(
                activity=self.activity,
                ruleset_version=version,
                stage_key="final_podium",
                status=StageResult.Status.READY_TO_CONFIRM,
                result_version=1,
                candidate_revision=facts["stage_result"]["candidate_revision"],
                input_fingerprint=facts["stage_result"]["input_fingerprint"],
                ruleset_hash=RULESET_HASH,
            )
            StageDecision.objects.create(
                stage_result=self.stage,
                singer=singer_a,
                outcome_code="finalist",
                rank=1,
                score=Decimal("98.30"),
            )
            StageDecision.objects.create(
                stage_result=self.stage,
                singer=singer_b,
                outcome_code="finalist",
                rank=2,
                score=Decimal("97.80"),
            )
            StageAwardDecision.objects.create(
                stage_result=self.stage,
                activity=self.activity,
                singer=singer_a,
                name="冠军",
            )
        with authority_write(STAGE_RESULT_CONFIRM):
            self.stage.status = StageResult.Status.CONFIRMED
            self.stage.confirmed_by = self.admin
            self.stage.confirmed_at = timezone.now()
            self.stage.save(update_fields=["status", "confirmed_by", "confirmed_at"])
        self.post = PublicPost.objects.create(
            title=facts["post"]["editorial_title"],
            post_type=PublicPost.PostType.RESULT_PUBLICATION,
            status=PublicPost.Status.PUBLISHED,
            related_activity=self.activity,
            version=1,
        )

    def _admin(self, actor: str) -> User:
        if actor.startswith("admin:"):
            assert self.admin is not None
            return self.admin
        assert self.staff is not None
        return self.staff

    def execute(self, command: str, actor: str, data: dict) -> dict:
        operator = self._admin(actor)
        if command == "release_result":
            assert self.post is not None and self.stage is not None
            with patch(
                "public_portal.services.build_result_closure",
                return_value=SimpleNamespace(closeable=True),
            ):
                release_result_post(self.post, self.stage, operator, note=data["note"])
            return {"events": ["ResultReleased"], "read_model": self.read_model()}
        if command == "edit_result_post":
            assert self.post is not None
            assert self.post.version == data["base_version"]
            self.post.title = data["editorial_title"]
            try:
                self.post.save(update_fields=["title"])
            except ValidationError as error:
                raise GoldenRejected("RESULT_POST_FROZEN") from error
            raise AssertionError("the frozen result post accepted an edit")
        if command == "revoke_result_release":
            assert self.post is not None
            revoke_result_release(self.post, operator, note=data["note"])
            return {"events": ["ResultReleaseRevoked"], "read_model": self.read_model()}
        if command == "unlock_stage_result":
            assert self.stage is not None
            unlock_stage_result(self.stage, operator=operator, note=data["note"])
            assert self.post is not None
            assert self.activity is not None
            self.stage = StageResult._base_manager.get(pk=self.stage.pk)
            return {
                "events": ["StageResultUnlocked", "ResultReleaseSuperseded"],
                "read_model": self.read_model(),
            }
        raise AssertionError(f"no v1 adapter for command {command!r}")

    def read_model(self) -> dict:
        assert self.post is not None and self.stage is not None
        latest = ResultRelease._base_manager.filter(post=self.post).order_by("-pk").first()
        snapshot = (latest.result_snapshot or {}) if latest else {}
        return {
            "release_status": latest.status if latest else None,
            "public_title": snapshot.get("public_title"),
            "snapshot_candidate_revision": snapshot.get("candidate_revision"),
            "snapshot_fingerprint": snapshot.get("input_fingerprint"),
            "snapshot_decisions": len(snapshot.get("decisions", [])),
            "release_history_count": ResultRelease._base_manager.filter(post=self.post).count(),
            "public_post_visible": PublicPost.published_public().filter(pk=self.post.pk).exists(),
            "stage_status": self.stage.status,
            "candidate_revision": self.stage.candidate_revision,
        }


ADAPTERS = {
    ResultReleaseAdapter.fixture_id: ResultReleaseAdapter,
}
