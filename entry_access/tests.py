from datetime import timedelta

from common.authority import (
    ACCESS_GRANT_STATE,
    ACCOUNT_AUTHORITY,
    CONTEST_ROUND_STATE,
    ENTRY_POINT_CONFIG,
    EPHEMERAL_SESSION_STATE,
    authority_write,
)
from common.models import AuditLog
from core.models import Activity
from django.apps import apps
from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import SimpleTestCase, TestCase
from django.urls import get_resolver
from django.utils import timezone
from singer_contest.models import ContestRound

from .models import AccessGrant, EntryPoint, EphemeralSession
from .services import create_entry_point, deactivate_entry_point, issue_access_grant

User = get_user_model()


class EntryAccessScaffoldTests(SimpleTestCase):
    def test_entry_access_app_is_registered(self):
        config = apps.get_app_config("entry_access")

        self.assertEqual(config.name, "entry_access")

    def test_entry_access_url_namespace_is_mounted(self):
        resolver = get_resolver()

        self.assertIn("entry_access", resolver.namespace_dict)


class EntryAccessModelTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Access model test", activity_type=Activity.Type.SINGER_CONTEST
        )
        with authority_write(ENTRY_POINT_CONFIG):
            self.entry_point = EntryPoint.objects.create(
                activity=self.activity,
                kind=EntryPoint.Kind.JUDGE,
                label="Judge bootstrap",
            )
        self.expires_at = timezone.now() + timedelta(minutes=10)

    def _grant_kwargs(self, **overrides):
        return {
            "entry_point": self.entry_point,
            "kind": EntryPoint.Kind.JUDGE,
            "activity": self.activity,
            "token_digest": "a" * 64,
            "expires_at": self.expires_at,
            **overrides,
        }

    def _create_grant(self, **overrides):
        with authority_write(ACCESS_GRANT_STATE):
            return AccessGrant.objects.create(**self._grant_kwargs(**overrides))

    def _create_session(self, grant, **overrides):
        with authority_write(EPHEMERAL_SESSION_STATE):
            return EphemeralSession.objects.create(
                grant=grant,
                kind=grant.kind,
                activity=grant.activity,
                token_digest="b" * 64,
                expires_at=self.expires_at,
                **overrides,
            )

    def test_grant_requires_explicit_authority_to_create(self):
        with self.assertRaisesMessage(ValidationError, "临时访问授权只能通过授权服务变更"):
            AccessGrant.objects.create(**self._grant_kwargs())

    def test_session_requires_explicit_authority_to_create(self):
        grant = self._create_grant()

        with self.assertRaisesMessage(ValidationError, "临时访问会话只能通过授权服务变更"):
            EphemeralSession.objects.create(
                grant=grant,
                kind=grant.kind,
                activity=grant.activity,
                token_digest="b" * 64,
                expires_at=self.expires_at,
            )

    def test_grant_rejects_entry_point_scope_mismatch(self):
        other_activity = Activity.objects.create(
            title="Other activity", activity_type=Activity.Type.SINGER_CONTEST
        )
        grant = AccessGrant(**self._grant_kwargs(activity=other_activity))

        with self.assertRaisesMessage(ValidationError, "访问授权范围与入口不一致"):
            grant.full_clean()

    def test_session_rejects_grant_scope_mismatch(self):
        grant = self._create_grant()
        other_activity = Activity.objects.create(
            title="Other activity", activity_type=Activity.Type.SINGER_CONTEST
        )
        session = EphemeralSession(
            grant=grant,
            kind=grant.kind,
            activity=other_activity,
            token_digest="b" * 64,
            expires_at=self.expires_at,
        )

        with self.assertRaisesMessage(ValidationError, "临时会话范围与授权不一致"):
            session.full_clean()

    def test_grant_scope_and_state_are_immutable_through_ordinary_orm_paths(self):
        grant = self._create_grant()
        grant.kind = EntryPoint.Kind.SCANNER
        with self.assertRaises(ValidationError):
            grant.save(update_fields=["kind"])

        with self.assertRaises(ValidationError):
            AccessGrant.objects.filter(pk=grant.pk).update(redeemed_at=timezone.now())
        with self.assertRaises(ValidationError):
            AccessGrant._base_manager.filter(pk=grant.pk).delete()

    def test_session_scope_and_state_are_immutable_through_bulk_paths(self):
        grant = self._create_grant()
        session = self._create_session(grant)
        session.kind = EntryPoint.Kind.SCANNER

        with self.assertRaises(ValidationError):
            EphemeralSession.objects.bulk_update([session], ["kind"])
        with self.assertRaises(ValidationError):
            EphemeralSession._base_manager.filter(pk=session.pk).update(revoked_at=timezone.now())
        with self.assertRaises(ValidationError):
            EphemeralSession.objects.bulk_create(
                [
                    EphemeralSession(
                        grant=grant,
                        kind=grant.kind,
                        activity=grant.activity,
                        token_digest="c" * 64,
                        expires_at=self.expires_at,
                    )
                ]
            )


class EntryAccessIssuanceTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Access issuance test", activity_type=Activity.Type.SINGER_CONTEST
        )
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="access-staff", password="pass", role=User.Role.STAFF
            )
        self.entry_point = create_entry_point(
            self.activity,
            kind=EntryPoint.Kind.JUDGE,
            label="Judge bootstrap",
            actor=self.staff,
        )

    def test_create_entry_point_requires_current_staff(self):
        participant = User.objects.create_user(username="access-participant", password="pass")

        with self.assertRaises(PermissionDenied):
            create_entry_point(
                self.activity,
                kind=EntryPoint.Kind.SCANNER,
                label="Scanner bootstrap",
                actor=participant,
            )

    def test_issue_returns_raw_token_once_and_persists_only_digest(self):
        result = issue_access_grant(
            self.entry_point,
            actor=self.staff,
            ttl=timedelta(minutes=5),
        )

        self.assertGreaterEqual(len(result.token), 43)
        self.assertNotEqual(result.token, result.grant.token_digest)
        self.assertEqual(len(result.grant.token_digest), 64)
        audit = AuditLog.objects.get(action_type=AuditLog.ActionType.ACCESS_GRANT_ISSUE)
        self.assertEqual(audit.operator, self.staff)
        self.assertNotIn(
            result.token, " ".join([audit.target, audit.old_value, audit.new_value, audit.note])
        )

    def test_issue_rejects_expired_or_overlong_ttl(self):
        for ttl in (timedelta(0), timedelta(minutes=31)):
            with self.subTest(ttl=ttl), self.assertRaises(ValidationError):
                issue_access_grant(self.entry_point, actor=self.staff, ttl=ttl)

    def test_issue_rejects_inactive_entry_point(self):
        deactivate_entry_point(self.entry_point, actor=self.staff)

        with self.assertRaises(ValidationError):
            issue_access_grant(self.entry_point, actor=self.staff, ttl=timedelta(minutes=5))

    def test_issue_rejects_round_from_another_activity(self):
        other_activity = Activity.objects.create(
            title="Other activity", activity_type=Activity.Type.SINGER_CONTEST
        )
        with authority_write(CONTEST_ROUND_STATE):
            other_round = ContestRound.objects.create(
                activity=other_activity,
                name="Other round",
                round_type=ContestRound.RoundType.PRELIMINARY,
            )

        with self.assertRaises(ValidationError):
            issue_access_grant(
                self.entry_point,
                actor=self.staff,
                ttl=timedelta(minutes=5),
                round=other_round,
            )

    def test_issue_rereads_actor_authority(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.PARTICIPANT
            self.staff.is_staff = False
            self.staff.save(update_fields=["role", "is_staff"])

        with self.assertRaises(PermissionDenied):
            issue_access_grant(self.entry_point, actor=self.staff, ttl=timedelta(minutes=5))
