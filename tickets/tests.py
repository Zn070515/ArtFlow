from __future__ import annotations

from datetime import timedelta

from common.authority import authority_write
from common.models import AuditLog
from core.models import Activity
from django.apps import apps
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone


TICKET_STATE_SCOPE = "ticket.state"
TICKET_SESSION_STATE_SCOPE = "ticket_access_session.state"


def ticket_model(test_case: TestCase):
    try:
        model = apps.get_model("tickets", "Ticket")
    except LookupError:
        model = None
    if model is None:
        test_case.fail("Ticket model is not registered")
    return model


def ticket_session_model(test_case: TestCase):
    try:
        model = apps.get_model("tickets", "TicketAccessSession")
    except LookupError:
        model = None
    if model is None:
        test_case.fail("TicketAccessSession model is not registered")
    return model


class TicketModelContractTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Ticket contract activity",
            activity_type=Activity.Type.GENERAL,
            is_test_mode=True,
        )

    def _ticket(self, **overrides):
        Ticket = ticket_model(self)
        values = {
            "activity": self.activity,
            "batch_reference": "BATCH-001",
            "serial_number": "0001",
            "state": Ticket.State.CREATED,
            "is_test_data": True,
            **overrides,
        }
        if "state" not in overrides and values.get("secret_digest"):
            values["state"] = Ticket.State.ISSUED
        with authority_write(TICKET_STATE_SCOPE):
            return Ticket.objects.create(**values)

    def test_ticket_model_is_registered_with_non_personal_authoritative_fields(self):
        Ticket = ticket_model(self)
        field_names = {field.name for field in Ticket._meta.get_fields()}

        self.assertTrue(
            {
                "activity",
                "batch_reference",
                "serial_number",
                "secret_digest",
                "state",
                "issued_at",
                "issued_by",
                "checked_in_at",
                "checked_in_by",
                "revoked_at",
                "revoked_by",
                "voided_at",
                "voided_by",
                "is_test_data",
                "created_at",
                "updated_at",
            }.issubset(field_names)
        )
        self.assertFalse(
            field_names.intersection({"name", "phone", "email", "class_name", "student_id"})
        )

    def test_created_ticket_has_no_redeemable_secret_and_string_is_non_secret(self):
        ticket = self._ticket(secret_digest=None)

        self.assertEqual(ticket.state, ticket_model(self).State.CREATED)
        self.assertIsNone(ticket.secret_digest)
        self.assertNotIn("secret", str(ticket).lower())
        self.assertNotIn("digest", str(ticket).lower())

    def test_inventory_identity_is_unique_inside_activity(self):
        self._ticket()

        with self.assertRaises(ValidationError):
            self._ticket()

    def test_same_inventory_identity_is_allowed_in_another_activity(self):
        self._ticket()
        other_activity = Activity.objects.create(
            title="Other ticket activity",
            activity_type=Activity.Type.GENERAL,
            is_test_mode=True,
        )
        Ticket = ticket_model(self)
        with authority_write(TICKET_STATE_SCOPE):
            other = Ticket.objects.create(
                activity=other_activity,
                batch_reference="BATCH-001",
                serial_number="0001",
                state=Ticket.State.CREATED,
                is_test_data=True,
            )
        self.assertEqual(other.activity_id, other_activity.pk)

    def test_direct_ticket_lifecycle_and_scope_writes_are_rejected(self):
        Ticket = ticket_model(self)
        ticket = self._ticket(secret_digest="a" * 64)

        ticket.state = Ticket.State.CHECKED_IN
        with self.assertRaises(ValidationError):
            ticket.save(update_fields=["state"])
        with self.assertRaises(ValidationError):
            Ticket.objects.filter(pk=ticket.pk).update(state=Ticket.State.ISSUED)
        with self.assertRaises(ValidationError):
            Ticket._base_manager.filter(pk=ticket.pk).update(secret_digest="b" * 64)
        with self.assertRaises(ValidationError):
            Ticket.objects.filter(pk=ticket.pk).delete()

    def test_ticket_bulk_paths_cannot_bypass_authority(self):
        Ticket = ticket_model(self)
        ticket = self._ticket(secret_digest="a" * 64)
        ticket.state = Ticket.State.ISSUED
        with self.assertRaises(ValidationError):
            Ticket.objects.bulk_update([ticket], ["state"])

        with self.assertRaises(ValidationError):
            Ticket.objects.bulk_create(
                [
                    Ticket(
                        activity=self.activity,
                        state=Ticket.State.CREATED,
                        secret_digest="c" * 64,
                        is_test_data=True,
                    )
                ],
                update_conflicts=True,
                update_fields=["secret_digest"],
                unique_fields=["secret_digest"],
            )


class TicketAccessSessionContractTests(TestCase):
    def setUp(self):
        self.activity = Activity.objects.create(
            title="Ticket session activity",
            activity_type=Activity.Type.GENERAL,
            is_test_mode=True,
        )
        Ticket = ticket_model(self)
        with authority_write(TICKET_STATE_SCOPE):
            self.ticket = Ticket.objects.create(
                activity=self.activity,
                state=Ticket.State.CHECKED_IN,
                secret_digest="d" * 64,
                is_test_data=True,
            )

    def _session(self, **overrides):
        Session = ticket_session_model(self)
        values = {
            "ticket": self.ticket,
            "token_digest": "e" * 64,
            "expires_at": timezone.now() + timedelta(minutes=30),
            "is_test_data": True,
            **overrides,
        }
        with authority_write(TICKET_SESSION_STATE_SCOPE):
            return Session.objects.create(**values)

    def test_session_has_digest_expiry_and_revocation_fields_without_raw_token(self):
        Session = ticket_session_model(self)
        field_names = {field.name for field in Session._meta.get_fields()}
        self.assertTrue(
            {"ticket", "token_digest", "expires_at", "last_seen_at", "revoked_at", "created_at"}
            .issubset(field_names)
        )
        session = self._session()
        self.assertEqual(len(session.token_digest), 64)
        self.assertNotIn(session.token_digest, str(session))

    def test_session_scope_and_delete_are_authority_guarded(self):
        Session = ticket_session_model(self)
        session = self._session()
        session.expires_at = timezone.now() + timedelta(hours=1)
        with self.assertRaises(ValidationError):
            session.save(update_fields=["expires_at"])
        with self.assertRaises(ValidationError):
            Session.objects.filter(pk=session.pk).update(revoked_at=timezone.now())
        with self.assertRaises(ValidationError):
            Session._base_manager.filter(pk=session.pk).delete()


class TicketAuditContractTests(TestCase):
    def test_ticket_audit_action_types_are_explicit_and_credential_free(self):
        actions = AuditLog.ActionType
        for name in (
            "TICKET_ISSUE",
            "TICKET_CHECK_IN",
            "TICKET_VOID",
            "TICKET_REVOKE",
            "TICKET_REDEEM",
            "TICKET_SESSION_REVOKE",
        ):
            with self.subTest(name=name):
                self.assertTrue(hasattr(actions, name))

        raw_secret = "raw-ticket-secret"
        raw_session_token = "raw-ticket-session-token"
        for value in (raw_secret, raw_session_token):
            self.assertNotIn(value, " ".join(str(action.value) for action in actions))
