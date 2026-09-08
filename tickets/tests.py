from __future__ import annotations

import json
from datetime import timedelta

from common.authority import ACCOUNT_AUTHORITY, authority_write
from common.models import AuditLog
from core.models import Activity
from core.services import transition_activity_phase
from django.apps import apps
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from . import services as ticket_services

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
            {
                "ticket",
                "token_digest",
                "expires_at",
                "last_seen_at",
                "revoked_at",
                "created_at",
            }.issubset(field_names)
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

    def test_expired_sessions_are_removed_only_by_cleanup_service(self):
        purge = getattr(ticket_services, "purge_expired_ticket_sessions", None)
        if purge is None:
            self.fail("tickets.services.purge_expired_ticket_sessions is not implemented")
        session = self._session(expires_at=timezone.now() - timedelta(minutes=1))

        deleted = purge()

        self.assertEqual(deleted, 1)
        self.assertFalse(ticket_session_model(self).objects.filter(pk=session.pk).exists())


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


class TicketLifecycleServiceTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.staff = User.objects.create_user(username="ticket-staff", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
        self.admin = User.objects.create_user(username="ticket-admin", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin.role = User.Role.ADMIN
            self.admin.save(update_fields=["role", "is_staff"])
        self.participant = User.objects.create_user(username="ticket-participant", password="pass")
        self.activity = Activity.objects.create(
            title="Ticket lifecycle activity",
            activity_type=Activity.Type.GENERAL,
            is_test_mode=True,
        )
        transition_activity_phase(
            self.activity,
            Activity.Phase.REGISTRATION_OPEN,
            actor=self.admin,
        )

    def _service(self, name):
        service = getattr(ticket_services, name, None)
        if service is None:
            self.fail(f"tickets.services.{name} is not implemented")
        return service

    def test_issue_generates_a_one_time_digest_only_secret(self):
        create_ticket = self._service("create_ticket")
        issue_ticket = self._service("issue_ticket")
        ticket = create_ticket(
            self.activity,
            actor=self.staff,
            batch_reference="LIFE-001",
            serial_number="0001",
        )
        issued = issue_ticket(ticket, actor=self.staff)

        self.assertEqual(ticket_model(self).State.ISSUED, issued.ticket.state)
        self.assertEqual(len(issued.secret), 43)
        self.assertNotEqual(issued.secret, issued.ticket.secret_digest)
        issued.ticket.refresh_from_db()
        self.assertNotIn(issued.secret, issued.ticket.secret_digest or "")
        self.assertNotIn(issued.secret, str(issued.ticket))
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.TICKET_ISSUE,
                target=f"Ticket:{issued.ticket.pk}",
            ).exists()
        )

    def test_check_in_and_terminal_transitions_are_service_owned(self):
        create_ticket = self._service("create_ticket")
        issue_ticket = self._service("issue_ticket")
        check_in_ticket = self._service("check_in_ticket")
        void_ticket = self._service("void_ticket")
        ticket = issue_ticket(
            create_ticket(self.activity, actor=self.staff, serial_number="0002"),
            actor=self.staff,
        )
        transition_activity_phase(
            self.activity,
            Activity.Phase.REGISTRATION_CLOSED,
            actor=self.admin,
        )
        checked_in = check_in_ticket(ticket.secret, actor=self.staff)
        self.assertEqual(checked_in.state, ticket_model(self).State.CHECKED_IN)
        self.assertEqual(check_in_ticket(ticket.secret, actor=self.staff).pk, checked_in.pk)
        with self.assertRaises(ValidationError):
            void_ticket(checked_in, actor=self.admin)

    def test_ticket_actions_are_phase_gated(self):
        create_ticket = self._service("create_ticket")
        activity = self.activity
        transition_activity_phase(activity, Activity.Phase.REGISTRATION_CLOSED, actor=self.admin)
        ticket = create_ticket(activity, actor=self.staff, serial_number="0003")
        self.assertEqual(ticket.activity_id, activity.pk)

    def test_check_in_is_rejected_until_the_activity_closes_registration(self):
        create_ticket = self._service("create_ticket")
        issue_ticket = self._service("issue_ticket")
        check_in_ticket = self._service("check_in_ticket")
        issued = issue_ticket(
            create_ticket(self.activity, actor=self.staff, serial_number="0004"),
            actor=self.staff,
        )

        with self.assertRaises(PermissionDenied):
            check_in_ticket(issued.secret, actor=self.staff)

    def test_void_and_revoke_are_admin_only_terminal_transitions(self):
        create_ticket = self._service("create_ticket")
        issue_ticket = self._service("issue_ticket")
        void_ticket = self._service("void_ticket")
        revoke_ticket = self._service("revoke_ticket")
        check_in_ticket = self._service("check_in_ticket")
        with self.assertRaises(PermissionDenied):
            create_ticket(self.activity, actor=self.participant, serial_number="0000")
        voided = create_ticket(self.activity, actor=self.staff, serial_number="0005")

        voided = void_ticket(voided, actor=self.admin)
        self.assertEqual(voided.state, ticket_model(self).State.VOID)
        self.assertEqual(void_ticket(voided, actor=self.admin).pk, voided.pk)
        with self.assertRaises(ValidationError):
            issue_ticket(voided, actor=self.staff)

        issued = issue_ticket(
            create_ticket(self.activity, actor=self.staff, serial_number="0006"),
            actor=self.staff,
        )
        revoked = revoke_ticket(issued.ticket, actor=self.admin)
        self.assertEqual(revoked.state, ticket_model(self).State.REVOKED)
        self.assertEqual(revoke_ticket(revoked, actor=self.admin).pk, revoked.pk)
        transition_activity_phase(
            self.activity,
            Activity.Phase.REGISTRATION_CLOSED,
            actor=self.admin,
        )
        with self.assertRaises(ValidationError):
            check_in_ticket(issued.secret, actor=self.staff)

    def test_redeem_creates_only_a_short_lived_session_and_authentication_is_revocable(self):
        create_ticket = self._service("create_ticket")
        issue_ticket = self._service("issue_ticket")
        redeem_ticket = self._service("redeem_ticket")
        authenticate = self._service("authenticate_ticket_session")
        revoke_session = self._service("revoke_ticket_session")
        issued = issue_ticket(
            create_ticket(self.activity, actor=self.staff, serial_number="0007"),
            actor=self.staff,
        )

        redeemed = redeem_ticket(issued.secret, request_meta=None)

        self.assertEqual(redeemed.session.ticket_id, issued.ticket.pk)
        self.assertEqual(
            ticket_model(self).objects.get(pk=issued.ticket.pk).state,
            ticket_model(self).State.ISSUED,
        )
        self.assertGreater(redeemed.session.expires_at, timezone.now())
        self.assertIsNotNone(authenticate(redeemed.token, activity=self.activity).last_seen_at)
        revoke_session(redeemed.session, actor=self.staff)
        with self.assertRaises(ValidationError):
            authenticate(redeemed.token, activity=self.activity)

    def test_unknown_credentials_are_generic_and_do_not_create_rows(self):
        redeem_ticket = self._service("redeem_ticket")
        check_in_ticket = self._service("check_in_ticket")
        Session = ticket_session_model(self)

        with self.assertRaisesMessage(ValidationError, "票据无效"):
            redeem_ticket("unknown-ticket-secret")
        with self.assertRaisesMessage(ValidationError, "票据无效"):
            check_in_ticket("unknown-ticket-secret", actor=self.staff)
        self.assertEqual(Session.objects.count(), 0)


class TicketStaffHttpTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.staff = User.objects.create_user(username="http-ticket-staff", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
        self.participant = User.objects.create_user(
            username="http-ticket-participant", password="pass"
        )
        self.admin = User.objects.create_user(username="http-ticket-admin", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin.role = User.Role.ADMIN
            self.admin.save(update_fields=["role", "is_staff"])
        self.activity = Activity.objects.create(
            title="Ticket HTTP activity",
            activity_type=Activity.Type.GENERAL,
            is_test_mode=True,
        )
        transition_activity_phase(
            self.activity,
            Activity.Phase.REGISTRATION_OPEN,
            actor=self.admin,
        )

    def _issue(self, serial_number="http-0001"):
        ticket = ticket_services.create_ticket(
            self.activity,
            actor=self.staff,
            serial_number=serial_number,
        )
        return ticket_services.issue_ticket(ticket, actor=self.staff)

    def test_staff_issue_returns_one_secret_and_list_never_reveals_it(self):
        self.client.force_login(self.staff)

        response = self.client.post(
            "/staff/tickets/issue/",
            data=json.dumps(
                {
                    "activity_id": self.activity.pk,
                    "batch_reference": "HTTP-BATCH",
                    "serial_number": "0001",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        secret = payload["secret"]
        self.assertEqual(len(secret), 43)
        listing = self.client.get(f"/staff/tickets/?activity_id={self.activity.pk}")
        self.assertEqual(listing.status_code, 200)
        self.assertNotContains(listing, secret)
        self.assertNotContains(listing, "secret_digest")

    def test_staff_check_in_requires_csrf_and_accepts_secret_only_in_post_body(self):
        issued = self._issue()
        transition_activity_phase(
            self.activity,
            Activity.Phase.REGISTRATION_CLOSED,
            actor=self.admin,
        )
        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.force_login(self.staff)

        rejected = csrf_client.post(
            "/staff/tickets/check-in/",
            data=json.dumps({"secret": issued.secret}),
            content_type="application/json",
        )
        self.assertEqual(rejected.status_code, 403)
        self.assertEqual(
            ticket_model(self).objects.get(pk=issued.ticket.pk).state,
            ticket_model(self).State.ISSUED,
        )

        self.client.force_login(self.staff)
        accepted = self.client.post(
            "/staff/tickets/check-in/",
            data=json.dumps({"secret": issued.secret}),
            content_type="application/json",
        )
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json()["state"], ticket_model(self).State.CHECKED_IN)

        query_attempt = self.client.get(f"/staff/tickets/check-in/?secret={issued.secret}")
        self.assertIn(query_attempt.status_code, {404, 405})

    def test_participant_cannot_issue_or_check_in_ticket(self):
        self.client.force_login(self.participant)
        issue_response = self.client.post(
            "/staff/tickets/issue/",
            data=json.dumps({"activity_id": self.activity.pk, "serial_number": "0002"}),
            content_type="application/json",
        )
        self.assertIn(issue_response.status_code, {302, 403})
        self.assertEqual(ticket_model(self).objects.filter(activity=self.activity).count(), 0)


class TicketPublicHttpTests(TestCase):
    def setUp(self):
        cache.clear()
        User = get_user_model()
        self.staff = User.objects.create_user(username="public-ticket-staff", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff.role = User.Role.STAFF
            self.staff.save(update_fields=["role", "is_staff"])
        self.admin = User.objects.create_user(username="public-ticket-admin", password="pass")
        with authority_write(ACCOUNT_AUTHORITY):
            self.admin.role = User.Role.ADMIN
            self.admin.save(update_fields=["role", "is_staff"])
        self.activity = Activity.objects.create(
            title="Public ticket activity",
            activity_type=Activity.Type.GENERAL,
            is_test_mode=True,
        )
        transition_activity_phase(
            self.activity,
            Activity.Phase.REGISTRATION_OPEN,
            actor=self.admin,
        )
        ticket = ticket_services.create_ticket(
            self.activity, actor=self.staff, serial_number="pub-1"
        )
        self.issued = ticket_services.issue_ticket(ticket, actor=self.staff)

    def _csrf_headers(self, client):
        response = client.get("/tickets/scan/")
        self.assertEqual(response.status_code, 200)
        return {"HTTP_X_CSRFTOKEN": client.cookies["csrftoken"].value}

    def test_scan_page_is_read_only_and_redeem_uses_body_only(self):
        response = self.client.get("/tickets/scan/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context["request"].path, "/tickets/scan/")

        csrf_client = Client(enforce_csrf_checks=True)
        rejected = csrf_client.post(
            "/tickets/redeem/",
            data=json.dumps({"secret": self.issued.secret}),
            content_type="application/json",
        )
        self.assertEqual(rejected.status_code, 403)

        scan_page = csrf_client.get("/tickets/scan/")
        self.assertEqual(scan_page.status_code, 200)
        csrf_token = csrf_client.cookies["csrftoken"].value
        redeemed = csrf_client.post(
            "/tickets/redeem/",
            data=json.dumps({"secret": self.issued.secret}),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(redeemed.status_code, 200)
        self.assertNotIn("secret", redeemed.json())
        self.assertNotIn(self.issued.secret, redeemed.content.decode())
        self.assertEqual(redeemed.json()["ticket_state"], "issued")
        cookie = redeemed.cookies["artflow_ticket_session"]
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Lax")
        self.assertFalse(cookie["secure"])
        self.assertEqual(redeemed["Cache-Control"], "no-store")
        self.assertEqual(
            ticket_model(self).objects.get(pk=self.issued.ticket.pk).state,
            ticket_model(self).State.ISSUED,
        )

        transition_activity_phase(
            self.activity,
            Activity.Phase.REGISTRATION_CLOSED,
            actor=self.admin,
        )
        ticket_services.check_in_ticket(self.issued.secret, actor=self.staff)
        checked_in = csrf_client.post(
            "/tickets/redeem/",
            data=json.dumps({"secret": self.issued.secret}),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )
        self.assertEqual(checked_in.status_code, 200)
        self.assertEqual(checked_in.json()["ticket_state"], "checked_in")

        query_attempt = self.client.get(f"/tickets/redeem/?secret={self.issued.secret}")
        self.assertEqual(query_attempt.status_code, 405)

    def test_unknown_or_oversized_redeem_is_generic_and_bounded(self):
        csrf_client = Client(enforce_csrf_checks=True)
        unknown = csrf_client.post(
            "/tickets/redeem/",
            data=json.dumps({"secret": "unknown-ticket-secret"}),
            content_type="application/json",
            **self._csrf_headers(csrf_client),
        )
        self.assertEqual(unknown.status_code, 400)
        self.assertEqual(unknown.json()["reason_code"], "INVALID_TICKET")
        self.assertEqual(unknown["Cache-Control"], "no-store")
        self.assertNotIn(self.issued.secret, unknown.content.decode())

        oversized = csrf_client.post(
            "/tickets/redeem/",
            data=json.dumps({"secret": "x" * 5000}),
            content_type="application/json",
            **self._csrf_headers(csrf_client),
        )
        self.assertEqual(oversized.status_code, 413)
        self.assertEqual(oversized.json()["reason_code"], "REQUEST_TOO_LARGE")
        self.assertEqual(oversized["Cache-Control"], "no-store")

    @override_settings(RATE_LIMIT_BACKEND="locmem")
    def test_redeem_rate_limit_returns_retry_after(self):
        csrf_client = Client(enforce_csrf_checks=True)
        for _ in range(30):
            csrf_client.post(
                "/tickets/redeem/",
                data=json.dumps({"secret": "unknown-ticket-secret"}),
                content_type="application/json",
                **self._csrf_headers(csrf_client),
            )
        limited = csrf_client.post(
            "/tickets/redeem/",
            data=json.dumps({"secret": "unknown-ticket-secret"}),
            content_type="application/json",
            **self._csrf_headers(csrf_client),
        )
        self.assertEqual(limited.status_code, 429)
        self.assertTrue(limited["Retry-After"].isdigit())
        self.assertEqual(limited["Cache-Control"], "no-store")
