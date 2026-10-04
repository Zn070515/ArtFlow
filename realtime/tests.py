from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from accounts.models import User
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from common.authority import ACCOUNT_AUTHORITY, authority_write
from config.asgi import application
from core.models import Activity
from django.test import TestCase
from django.db import transaction
from singer_contest.judge_authority import JudgeContext

from .events import schedule_judge_context_event


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


class JudgeContextConsumerTests(TestCase):
    def _judge_context(self) -> JudgeContext:
        return JudgeContext(
            activity_id=1,
            activity_name="测试歌手赛",
            round_id=9,
            round_name="决赛",
            seat_id=3,
            seat_label="J3",
            panel_snapshot_id=4,
            panel_version=1,
            context_version=7,
            performance_id=None,
            performance_label=None,
            singer_name=None,
            song_title=None,
            performance_state="idle",
            rubric_payload={"name": "评分表", "criteria": []},
        )

    def test_missing_judge_cookie_is_rejected(self):
        async def exercise():
            communicator = WebsocketCommunicator(
                application,
                "/ws/judge/",
                headers=[
                    (b"host", b"testserver"),
                    (b"origin", b"http://testserver"),
                ],
            )
            connected, detail = await communicator.connect()
            self.assertFalse(connected)
            self.assertEqual(detail, 4401)

        async_to_sync(exercise)()

    @patch("singer_contest.judge_authority.get_judge_context_readonly")
    def test_cookie_authenticates_without_client_supplied_round(self, context_mock):
        context_mock.return_value = self._judge_context()

        async def exercise():
            communicator = WebsocketCommunicator(
                application,
                "/ws/judge/?round_id=9999",
                headers=[
                    (b"host", b"testserver"),
                    (b"origin", b"http://testserver"),
                    (b"cookie", b"artflow_judge_session=opaque-session"),
                ],
            )
            connected, detail = await communicator.connect()
            self.assertTrue(connected, detail)
            ready = await communicator.receive_json_from()
            self.assertEqual(ready["type"], "realtime.ready")
            self.assertEqual(ready["resource"], "judge-context:9")
            self.assertEqual(ready["revision"], 7)

            await communicator.send_json_to({"type": "heartbeat"})
            await communicator.send_json_to({"type": "unsupported"})
            error = await communicator.receive_json_from()
            self.assertEqual(error["code"], "UNSUPPORTED_REALTIME_MESSAGE")

            await communicator.disconnect()

        async_to_sync(exercise)()

    @patch("singer_contest.judge_authority.get_judge_context_readonly")
    def test_context_event_is_forwarded_without_business_payload(self, context_mock):
        context_mock.return_value = self._judge_context()

        async def exercise():
            communicator = WebsocketCommunicator(
                application,
                "/ws/judge/",
                headers=[
                    (b"host", b"testserver"),
                    (b"origin", b"http://testserver"),
                    (b"cookie", b"artflow_judge_session=opaque-session"),
                ],
            )
            connected, _ = await communicator.connect()
            self.assertTrue(connected)
            await communicator.receive_json_from()
            await get_channel_layer().group_send(
                "judge_round_9",
                {
                    "type": "realtime.event",
                    "event": "judge.context_changed",
                    "resource": "judge-context:9",
                    "revision": 8,
                    "actor": {"id": 1, "display": "staff"},
                },
            )
            changed = await communicator.receive_json_from()
            self.assertEqual(changed["type"], "judge.context_changed")
            self.assertEqual(changed["revision"], 8)
            self.assertNotIn("context", changed)
            await communicator.disconnect()

        async_to_sync(exercise)()


class RealtimeEventTests(TestCase):
    @patch("realtime.events.get_channel_layer")
    def test_judge_event_publishes_only_after_commit(self, get_channel_layer_mock):
        group_send = AsyncMock()
        get_channel_layer_mock.return_value = SimpleNamespace(group_send=group_send)

        with self.captureOnCommitCallbacks(execute=True):
            with transaction.atomic():
                schedule_judge_context_event(round_id=9, revision=3)
                group_send.assert_not_awaited()

        group_send.assert_awaited_once()
        self.assertEqual(group_send.await_args.args[0], "judge_round_9")
        self.assertEqual(group_send.await_args.args[1]["event"], "judge.context_changed")
        self.assertEqual(group_send.await_args.args[1]["revision"], 3)

    @patch("realtime.events.get_channel_layer")
    def test_rolled_back_judge_event_is_not_published(self, get_channel_layer_mock):
        group_send = AsyncMock()
        get_channel_layer_mock.return_value = SimpleNamespace(group_send=group_send)

        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                schedule_judge_context_event(round_id=9, revision=4)
                raise RuntimeError("rollback")

        group_send.assert_not_awaited()
