from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from accounts.models import User
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer  # type: ignore[import-untyped]
from channels.testing import WebsocketCommunicator  # type: ignore[import-untyped]
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from config.asgi import application
from core.models import Activity
from django.db import transaction
from django.test import TestCase
from singer_contest.judge_authority import JudgeContext

from .events import (
    schedule_activity_event,
    schedule_group_material_event,
    schedule_judge_context_event,
)


def _recorded_call(mock: AsyncMock):
    """The awaited call recorded on ``mock``, narrowed for the type checker."""
    recorded = mock.await_args
    assert recorded is not None, "expected the mock to have been awaited"
    return recorded


def _session_cookie_headers(user) -> list[tuple[bytes, bytes]]:
    """Handshake headers carrying a real session for ``user``."""
    from django.contrib.sessions.backends.db import SessionStore

    session = SessionStore()
    session["_auth_user_id"] = str(user.pk)
    session["_auth_user_backend"] = "django.contrib.auth.backends.ModelBackend"
    session["_auth_user_hash"] = user.get_session_auth_hash()
    session.save()
    return [
        (b"host", b"testserver"),
        (b"origin", b"http://testserver"),
        (b"cookie", f"sessionid={session.session_key}".encode("ascii")),
    ]


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
        return _session_cookie_headers(self.staff)

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


class GroupMaterialConsumerTests(TestCase):
    """Presence in a group material room must carry enough to remove the leaver."""

    def setUp(self):
        from singer_contest.group_chorus import (
            confirm_group_stage,
            create_group_stage,
            record_group_stage,
        )
        from singer_contest.models import Group, SingerRegistration

        with authority_write(ACCOUNT_AUTHORITY):
            self.staff = User.objects.create_user(
                username="group-room-staff",
                password="password123!",
                role=User.Role.STAFF,
            )
            singer_user = User.objects.create_user(
                username="group-room-singer", password="password123!"
            )
        self.activity = Activity.objects.create(
            title="Group Room Test",
            activity_type=Activity.Type.SINGER_CONTEST,
            is_test_mode=True,
        )
        with authority_write(ACTIVITY_STATE):
            Activity.objects.filter(pk=self.activity.pk).update(phase=Activity.Phase.REHEARSAL)
        self.activity.refresh_from_db()
        singer = SingerRegistration.objects.create(
            activity=self.activity,
            user=singer_user,
            name="选手",
            student_id="20260001",
            college="艺术学院",
            class_name="一班",
            phone="13800000000",
            song_name="曲目",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        stage = create_group_stage(
            self.activity, stage_key="chorus", name="分组合唱", operator=self.staff
        )
        record_group_stage(stage, [{"name": "A组", "singer_ids": [singer.pk]}], self.staff)
        confirm_group_stage(stage, self.staff)
        self.group = Group.objects.get(stage=stage, name="A组")

    def test_group_presence_leave_names_the_client_that_left(self):
        headers = _session_cookie_headers(self.staff)

        async def exercise():
            base = f"/ws/group/{self.group.pk}/materials/"
            first = WebsocketCommunicator(
                application, f"{base}?client_id=groupone", headers=headers
            )
            second = WebsocketCommunicator(
                application, f"{base}?client_id=grouptwo", headers=headers
            )
            first_connected, _ = await first.connect()
            self.assertTrue(first_connected)
            self.assertEqual((await first.receive_json_from())["type"], "presence.snapshot")
            self.assertEqual((await first.receive_json_from())["type"], "presence.join")

            second_connected, _ = await second.connect()
            self.assertTrue(second_connected)
            self.assertEqual((await second.receive_json_from())["type"], "presence.snapshot")
            self.assertEqual((await second.receive_json_from())["type"], "presence.join")
            self.assertEqual((await first.receive_json_from())["type"], "presence.join")

            await first.disconnect()
            left = await second.receive_json_from()
            self.assertEqual(left["type"], "presence.leave")
            # Without this the client cannot match the departure to a roster entry, and the
            # departed member stays listed until a full snapshot.
            self.assertEqual(left["client_id"], "groupone")
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
    def test_group_material_event_targets_the_group_room(self, get_channel_layer_mock):
        group_send = AsyncMock()
        get_channel_layer_mock.return_value = SimpleNamespace(group_send=group_send)

        with self.captureOnCommitCallbacks(execute=True):
            with transaction.atomic():
                schedule_group_material_event(
                    17,
                    event="group.material_changed",
                    revision=4,
                    details={"file_id": 9},
                )

        group_send.assert_awaited_once()
        self.assertEqual(_recorded_call(group_send).args[0], "group_material_17")
        self.assertEqual(_recorded_call(group_send).args[1]["resource"], "group:17:materials")

    @patch("realtime.events.get_channel_layer")
    def test_activity_event_carries_accepted_patch_details_after_commit(
        self, get_channel_layer_mock
    ):
        group_send = AsyncMock()
        get_channel_layer_mock.return_value = SimpleNamespace(group_send=group_send)

        with self.captureOnCommitCallbacks(execute=True):
            with transaction.atomic():
                schedule_activity_event(
                    12,
                    event="score.grid_changed",
                    resource="round-score:5",
                    revision=8,
                    details={"changes": [{"singer_id": 1, "judge_id": 2, "score": "91"}]},
                )
                group_send.assert_not_awaited()

        group_send.assert_awaited_once()
        self.assertEqual(_recorded_call(group_send).args[0], "staff_activity_12")
        self.assertEqual(
            _recorded_call(group_send).args[1]["details"],
            {"changes": [{"singer_id": 1, "judge_id": 2, "score": "91"}]},
        )

    @patch("realtime.events.get_channel_layer")
    def test_judge_event_publishes_only_after_commit(self, get_channel_layer_mock):
        group_send = AsyncMock()
        get_channel_layer_mock.return_value = SimpleNamespace(group_send=group_send)

        with self.captureOnCommitCallbacks(execute=True):
            with transaction.atomic():
                schedule_judge_context_event(round_id=9, revision=3)
                group_send.assert_not_awaited()

        group_send.assert_awaited_once()
        self.assertEqual(_recorded_call(group_send).args[0], "judge_round_9")
        self.assertEqual(_recorded_call(group_send).args[1]["event"], "judge.context_changed")
        self.assertEqual(_recorded_call(group_send).args[1]["revision"], 3)

    @patch("realtime.events.get_channel_layer")
    def test_rolled_back_judge_event_is_not_published(self, get_channel_layer_mock):
        group_send = AsyncMock()
        get_channel_layer_mock.return_value = SimpleNamespace(group_send=group_send)

        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                schedule_judge_context_event(round_id=9, revision=4)
                raise RuntimeError("rollback")

        group_send.assert_not_awaited()
