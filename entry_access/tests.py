import hashlib
from datetime import timedelta
from unittest import skipUnless

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
from django.contrib import admin as django_admin
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import close_old_connections, connection
from django.test import (
    Client,
    RequestFactory,
    SimpleTestCase,
    TestCase,
    TransactionTestCase,
    override_settings,
)
from django.urls import NoReverseMatch, get_resolver, reverse
from django.utils import timezone
from singer_contest.models import ContestRound

from .models import AccessGrant, EntryPoint, EphemeralSession
from .services import (
    AccessRequestMeta,
    authenticate_ephemeral_session,
    create_entry_point,
    deactivate_entry_point,
    issue_access_grant,
    redeem_access_grant,
    revoke_access_grant,
    revoke_ephemeral_session,
)

User = get_user_model()


class EntryAccessScaffoldTests(SimpleTestCase):
    def test_entry_access_app_is_registered(self):
        config = apps.get_app_config("entry_access")

        self.assertEqual(config.name, "entry_access")

    def test_entry_access_url_namespace_is_mounted(self):
        resolver = get_resolver()

        self.assertIn("entry_access", resolver.namespace_dict)

    def test_admin_exposes_only_read_only_non_secret_inspection(self):
        for model in (AccessGrant, EntryPoint, EphemeralSession):
            with self.subTest(model=model.__name__):
                model_admin = django_admin.site._registry[model]
                request = RequestFactory().get("/")
                self.assertFalse(model_admin.has_add_permission(request))
                self.assertFalse(model_admin.has_change_permission(request))
                self.assertFalse(model_admin.has_delete_permission(request))
                if model in (AccessGrant, EphemeralSession):
                    self.assertIn("token_digest", model_admin.get_exclude(request) or ())


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


class EntryAccessRedemptionTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Access redemption test", activity_type=Activity.Type.SINGER_CONTEST
        )
        other_activity = Activity.objects.create(
            title="Other activity", activity_type=Activity.Type.SINGER_CONTEST
        )
        self.other_activity = other_activity
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="redemption-staff", password="pass", role=User.Role.STAFF
            )
        self.entry_point = create_entry_point(
            self.activity,
            kind=EntryPoint.Kind.JUDGE,
            label="Judge bootstrap",
            actor=self.staff,
        )
        self.issued = issue_access_grant(
            self.entry_point,
            actor=self.staff,
            ttl=timedelta(minutes=5),
        )

    def test_redeem_creates_separate_short_lived_session(self):
        result = redeem_access_grant(
            self.issued.token,
            request_meta=AccessRequestMeta(ip_address="198.51.100.7"),
        )

        self.issued.grant.refresh_from_db()
        self.assertIsNotNone(self.issued.grant.redeemed_at)
        self.assertNotEqual(result.token, result.session.token_digest)
        self.assertEqual(result.session.grant_id, self.issued.grant.pk)
        self.assertEqual(result.session.kind, self.issued.grant.kind)
        self.assertEqual(result.session.activity_id, self.issued.grant.activity_id)
        self.assertLessEqual(result.session.expires_at, self.issued.grant.expires_at)
        audit = AuditLog.objects.get(action_type=AuditLog.ActionType.ACCESS_GRANT_REDEEM)
        self.assertIsNone(audit.operator)
        self.assertEqual(audit.ip_address, "198.51.100.7")
        self.assertNotIn(
            result.token, " ".join([audit.target, audit.old_value, audit.new_value, audit.note])
        )

    def test_redeem_is_single_use(self):
        redeem_access_grant(self.issued.token)

        with self.assertRaisesMessage(ValidationError, "临时访问授权无效"):
            redeem_access_grant(self.issued.token)

        self.assertEqual(EphemeralSession.objects.count(), 1)

    def test_redeem_rejects_malformed_unknown_and_expired_tokens(self):
        for token in ("", "x" * 129, "not-a-real-token", "中文 token"):
            with self.subTest(token=token), self.assertRaises(ValidationError):
                redeem_access_grant(token)

        expired_token = "expired-token"
        with authority_write(ACCESS_GRANT_STATE):
            AccessGrant.objects.create(
                entry_point=self.entry_point,
                kind=EntryPoint.Kind.JUDGE,
                activity=self.activity,
                token_digest=hashlib.sha256(expired_token.encode()).hexdigest(),
                expires_at=timezone.now() - timedelta(seconds=1),
            )

        with self.assertRaisesMessage(ValidationError, "临时访问授权无效"):
            redeem_access_grant(expired_token)

    def test_redeem_rejects_revoked_grant(self):
        with authority_write(ACCESS_GRANT_STATE):
            self.issued.grant.revoked_at = timezone.now()
            self.issued.grant.save(update_fields=["revoked_at"])

        with self.assertRaisesMessage(ValidationError, "临时访问授权无效"):
            redeem_access_grant(self.issued.token)

    def test_session_authentication_enforces_exact_scope(self):
        result = redeem_access_grant(self.issued.token)
        authenticated = authenticate_ephemeral_session(
            result.token,
            expected_kind=EntryPoint.Kind.JUDGE,
            activity=self.activity,
        )

        self.assertEqual(authenticated.pk, result.session.pk)
        authenticated.refresh_from_db()
        self.assertIsNotNone(authenticated.last_seen_at)

        with self.assertRaises(ValidationError):
            authenticate_ephemeral_session(
                result.token,
                expected_kind=EntryPoint.Kind.SCANNER,
                activity=self.activity,
            )
        with self.assertRaises(ValidationError):
            authenticate_ephemeral_session(
                result.token,
                expected_kind=EntryPoint.Kind.JUDGE,
                activity=self.other_activity,
            )

    def test_session_authentication_rejects_expired_session(self):
        session_token = "expired-session"
        with authority_write(EPHEMERAL_SESSION_STATE):
            grant = self._expired_session_grant()
            EphemeralSession.objects.create(
                grant=grant,
                kind=grant.kind,
                activity=grant.activity,
                token_digest=hashlib.sha256(session_token.encode()).hexdigest(),
                expires_at=timezone.now() - timedelta(seconds=1),
            )

        with self.assertRaises(ValidationError):
            authenticate_ephemeral_session(
                session_token,
                expected_kind=EntryPoint.Kind.JUDGE,
                activity=self.activity,
            )

    def _expired_session_grant(self):
        with authority_write(ACCESS_GRANT_STATE):
            return AccessGrant.objects.create(
                entry_point=self.entry_point,
                kind=EntryPoint.Kind.JUDGE,
                activity=self.activity,
                token_digest=hashlib.sha256(b"expired-session-grant").hexdigest(),
                expires_at=timezone.now() + timedelta(minutes=5),
            )


@skipUnless(connection.vendor == "postgresql", "requires PostgreSQL row locks")
class EntryAccessRedemptionConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.activity = Activity.objects.create(
            title="Concurrent access test", activity_type=Activity.Type.SINGER_CONTEST
        )
        with authority_write(ACCOUNT_AUTHORITY):
            staff = User.objects.create_user(
                username="concurrent-access-staff", password="pass", role=User.Role.STAFF
            )
        entry_point = create_entry_point(
            self.activity,
            kind=EntryPoint.Kind.SCANNER,
            label="Scanner bootstrap",
            actor=staff,
        )
        self.token = issue_access_grant(
            entry_point,
            actor=staff,
            ttl=timedelta(minutes=5),
        ).token

    def test_concurrent_redeem_creates_one_session(self):
        import threading

        results = []
        barrier = threading.Barrier(2)

        def redeem():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                results.append(redeem_access_grant(self.token))
            except Exception as error:  # pragma: no cover - assertion below reports it
                results.append(error)
            finally:
                close_old_connections()

        threads = [threading.Thread(target=redeem) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertEqual(len(results), 2)
        self.assertEqual(sum(not isinstance(result, Exception) for result in results), 1)
        self.assertEqual(EphemeralSession.objects.count(), 1)


class EntryAccessRevocationTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Access revocation test", activity_type=Activity.Type.SINGER_CONTEST
        )
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="revocation-staff", password="pass", role=User.Role.STAFF
            )
        self.entry_point = create_entry_point(
            self.activity,
            kind=EntryPoint.Kind.OPERATIONAL,
            label="Operational bootstrap",
            actor=self.staff,
        )

    def _issue(self):
        return issue_access_grant(
            self.entry_point,
            actor=self.staff,
            ttl=timedelta(minutes=5),
        )

    def test_revoke_access_grant_blocks_redemption_and_is_idempotent(self):
        issued = self._issue()

        revoked = revoke_access_grant(issued.grant, actor=self.staff, note="lost device")

        self.assertIsNotNone(revoked.revoked_at)
        with self.assertRaises(ValidationError):
            redeem_access_grant(issued.token)

        again = revoke_access_grant(issued.grant, actor=self.staff, note="duplicate request")
        self.assertEqual(again.revoked_at, revoked.revoked_at)
        self.assertEqual(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.ACCESS_GRANT_REVOKE).count(),
            1,
        )
        audit = AuditLog.objects.get(action_type=AuditLog.ActionType.ACCESS_GRANT_REVOKE)
        self.assertEqual(audit.operator, self.staff)
        self.assertEqual(audit.note, "lost device")
        self.assertNotIn(issued.token, " ".join([audit.target, audit.old_value, audit.new_value]))

    def test_revoke_redeemed_grant_does_not_reopen_or_destroy_session(self):
        issued = self._issue()
        session_result = redeem_access_grant(issued.token)

        revoke_access_grant(issued.grant, actor=self.staff, note="rotate bootstrap")

        with self.assertRaises(ValidationError):
            redeem_access_grant(issued.token)
        authenticated = authenticate_ephemeral_session(
            session_result.token,
            expected_kind=EntryPoint.Kind.OPERATIONAL,
            activity=self.activity,
        )
        self.assertEqual(authenticated.pk, session_result.session.pk)

    def test_revoke_ephemeral_session_blocks_authentication_and_is_idempotent(self):
        issued = self._issue()
        session_result = redeem_access_grant(issued.token)

        revoked = revoke_ephemeral_session(
            session_result.session, actor=self.staff, note="operator signed out"
        )

        self.assertIsNotNone(revoked.revoked_at)
        with self.assertRaises(ValidationError):
            authenticate_ephemeral_session(
                session_result.token,
                expected_kind=EntryPoint.Kind.OPERATIONAL,
                activity=self.activity,
            )

        again = revoke_ephemeral_session(
            session_result.session, actor=self.staff, note="duplicate request"
        )
        self.assertEqual(again.revoked_at, revoked.revoked_at)
        self.assertEqual(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.ACCESS_SESSION_REVOKE).count(),
            1,
        )

    def test_revocation_rereads_actor_authority(self):
        issued = self._issue()
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.PARTICIPANT
            self.staff.is_staff = False
            self.staff.save(update_fields=["role", "is_staff"])

        with self.assertRaises(PermissionDenied):
            revoke_access_grant(issued.grant, actor=self.staff, note="stale actor")


class EntryAccessHttpTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = Client()
        self.activity = Activity.objects.create(
            title="Access HTTP test", activity_type=Activity.Type.SINGER_CONTEST
        )
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="http-staff", password="pass", role=User.Role.STAFF
            )
        self.entry_point = create_entry_point(
            self.activity,
            kind=EntryPoint.Kind.SCANNER,
            label="Scanner HTTP",
            actor=self.staff,
        )

    def test_generic_mutation_routes_are_not_public(self):
        for route_name in (
            "entry_access:grant_issue",
            "entry_access:grant_revoke",
            "entry_access:session_revoke",
        ):
            with self.subTest(route_name=route_name), self.assertRaises(NoReverseMatch):
                reverse(route_name)

        self.assertEqual(self.client.post("/entry-access/grants/issue/").status_code, 404)
        self.assertEqual(self.client.post("/entry-access/grants/1/revoke/").status_code, 404)
        self.assertEqual(self.client.post("/entry-access/sessions/1/revoke/").status_code, 404)

    def test_redeem_is_explicit_post_and_does_not_put_token_in_url(self):
        issued = issue_access_grant(
            self.entry_point,
            actor=self.staff,
            ttl=timedelta(minutes=5),
        )
        redeem_url = reverse("entry_access:grant_redeem")

        get_response = self.client.get(f"{redeem_url}?token={issued.token}")
        self.assertEqual(get_response.status_code, 405)
        self.assertIsNone(AccessGrant.objects.get(pk=issued.grant.pk).redeemed_at)

        post_response = self.client.post(
            redeem_url,
            data={"token": issued.token},
            content_type="application/json",
        )
        self.assertEqual(post_response.status_code, 200)
        self.assertEqual(post_response["Cache-Control"], "no-store")
        self.assertEqual(post_response["Pragma"], "no-cache")
        self.assertIn("session_token", post_response.json())

    def test_redeem_invalid_grant_has_generic_reason(self):
        response = self.client.post(
            reverse("entry_access:grant_redeem"),
            data={"token": "unknown-token"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(), {"detail": "临时访问授权无效。", "reason_code": "INVALID_GRANT"}
        )

    def test_redeem_rejects_invalid_json_as_invalid_request(self):
        response = self.client.post(
            reverse("entry_access:grant_redeem"),
            data="not-json",
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["reason_code"], "INVALID_REQUEST")

    def test_redeem_rejects_payload_above_route_limit(self):
        response = self.client.post(
            reverse("entry_access:grant_redeem"),
            data=b'{"token":"' + b"x" * (4096 + 1) + b'"}',
            content_type="application/json",
            REMOTE_ADDR="198.51.100.10",
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["reason_code"], "REQUEST_TOO_LARGE")

    def test_redeem_rate_limits_attempts_by_ip(self):
        for _ in range(30):
            response = self.client.post(
                reverse("entry_access:grant_redeem"),
                data={"token": "unknown-token"},
                content_type="application/json",
                REMOTE_ADDR="198.51.100.11",
            )
            self.assertEqual(response.status_code, 400)

        throttled = self.client.post(
            reverse("entry_access:grant_redeem"),
            data={"token": "unknown-token"},
            content_type="application/json",
            REMOTE_ADDR="198.51.100.11",
        )

        self.assertEqual(throttled.status_code, 429)
        self.assertEqual(throttled.json()["reason_code"], "RATE_LIMITED")
        self.assertIn("Retry-After", throttled)

    @override_settings(TRUST_X_FORWARDED_FOR=True)
    def test_redeem_rate_limits_by_trusted_client_ip(self):
        for _ in range(30):
            response = self.client.post(
                reverse("entry_access:grant_redeem"),
                data={"token": "unknown-token"},
                content_type="application/json",
                REMOTE_ADDR="172.19.0.5",
                HTTP_X_FORWARDED_FOR="198.51.100.20",
            )
            self.assertEqual(response.status_code, 400)

        other_client = self.client.post(
            reverse("entry_access:grant_redeem"),
            data={"token": "unknown-token"},
            content_type="application/json",
            REMOTE_ADDR="172.19.0.5",
            HTTP_X_FORWARDED_FOR="198.51.100.21",
        )

        self.assertEqual(other_client.status_code, 400)

    @override_settings(TRUST_X_FORWARDED_FOR=True)
    def test_redeem_audit_uses_trusted_client_ip(self):
        issued = issue_access_grant(
            self.entry_point,
            actor=self.staff,
            ttl=timedelta(minutes=5),
        )

        response = self.client.post(
            reverse("entry_access:grant_redeem"),
            data={"token": issued.token},
            content_type="application/json",
            REMOTE_ADDR="172.19.0.5",
            HTTP_X_FORWARDED_FOR="198.51.100.22, 172.19.0.5",
        )

        self.assertEqual(response.status_code, 200)
        audit = AuditLog.objects.get(action_type=AuditLog.ActionType.ACCESS_GRANT_REDEEM)
        self.assertEqual(audit.ip_address, "198.51.100.22")

    def test_redeem_does_not_require_csrf_cookie(self):
        issued = issue_access_grant(
            self.entry_point,
            actor=self.staff,
            ttl=timedelta(minutes=5),
        )
        csrf_client = Client(enforce_csrf_checks=True)

        response = csrf_client.post(
            reverse("entry_access:grant_redeem"),
            data={"token": issued.token},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)