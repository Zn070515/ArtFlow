from datetime import timedelta

from common.authority import (
    ACCESS_GRANT_STATE,
    ENTRY_POINT_CONFIG,
    EPHEMERAL_SESSION_STATE,
    authority_write,
)
from core.models import Activity
from django.apps import apps
from django.core.exceptions import ValidationError
from django.test import SimpleTestCase, TestCase
from django.urls import get_resolver
from django.utils import timezone

from .models import AccessGrant, EntryPoint, EphemeralSession


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
