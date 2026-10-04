from __future__ import annotations

from accounts.models import User
from asgiref.sync import async_to_sync
from channels.testing import WebsocketCommunicator
from common.authority import ACCOUNT_AUTHORITY, authority_write
from config.asgi import application
from core.models import Activity
from django.test import TestCase


class StaffActivityConsumerTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="realtime-staff",
                password="password123!",
                role=User.Role.STAFF,
            )
        self.activity = Activity.objects.create(
            title="Realtime Test",
            activity_type=Activity.Type.SINGER_CONTEST,
        )

    def _cookie_headers(self) -> list[tuple[bytes, bytes]]:
        from django.contrib.sessions.backends.db import SessionStore

        session = SessionStore()
        session["_auth_user_id"] = str(self.staff.pk)
        session["_auth_user_backend"] = "django.contrib.auth.backends.ModelBackend"
        session["_auth_user_hash"] = self.staff.get_session_auth_hash()
        session.save()
        return [
            (b"host", b"testserver"),
            (b"origin", b"http://testserver"),
            (b"cookie", f"sessionid={session.session_key}".encode("ascii")),
        ]

    def test_anonymous_activity_socket_is_rejected(self):
        async def exercise():
            communicator = WebsocketCommunicator(
                application,
                f"/ws/staff/activity/{self.activity.pk}/?client_id=anonymous1",
                headers=[
                    (b"host", b"testserver"),
                    (b"origin", b"http://testserver"),
                ],
            )
            connected, detail = await communicator.connect()
            self.assertFalse(connected)
            self.assertEqual(detail, 4403)

        async_to_sync(exercise)()

    def test_staff_activity_socket_exposes_ephemeral_presence(self):
        headers = self._cookie_headers()

        async def exercise():
            path = f"/ws/staff/activity/{self.activity.pk}/?client_id=clientone"
            first = WebsocketCommunicator(application, path, headers=headers)
            second = WebsocketCommunicator(
                application,
                f"/ws/staff/activity/{self.activity.pk}/?client_id=clienttwo",
                headers=headers,
            )
            first_connected, _ = await first.connect()
            self.assertTrue(first_connected)
            first_snapshot = await first.receive_json_from()
            self.assertEqual(first_snapshot["type"], "presence.snapshot")
            first_join = await first.receive_json_from()
            self.assertEqual(first_join["type"], "presence.join")
            self.assertEqual(first_join["member"]["client_id"], "clientone")

            second_connected, _ = await second.connect()
            self.assertTrue(second_connected)
            second_snapshot = await second.receive_json_from()
            self.assertEqual(second_snapshot["type"], "presence.snapshot")
            self.assertEqual(
                {member["client_id"] for member in second_snapshot["members"]},
                {"clientone", "clienttwo"},
            )
            second_join = await second.receive_json_from()
            self.assertEqual(second_join["type"], "presence.join")
            self.assertEqual(second_join["member"]["client_id"], "clienttwo")

            join = await first.receive_json_from()
            self.assertEqual(join["type"], "presence.join")
            self.assertEqual(join["member"]["client_id"], "clienttwo")

            await first.send_json_to({"type": "presence.focus", "path": "score:17:4"})
            focused = await second.receive_json_from()
            self.assertEqual(focused["type"], "presence.focus")
            self.assertEqual(focused["member"]["path"], "score:17:4")

            await first.disconnect()
            left = await second.receive_json_from()
            self.assertEqual(left["type"], "presence.leave")
            self.assertEqual(left["client_id"], "clientone")
            await second.disconnect()

        async_to_sync(exercise)()
