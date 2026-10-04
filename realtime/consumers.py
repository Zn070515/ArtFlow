from __future__ import annotations

import re
from http.cookies import SimpleCookie
from typing import Any

from accounts.models import User
from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer  # type: ignore[import-untyped]
from core.models import Activity
from django.core.exceptions import PermissionDenied, ValidationError

from .presence import PresenceMember, redis_presence_store

_CLIENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
_PATH_MAX_LENGTH = 160


class StaffActivityConsumer(AsyncJsonWebsocketConsumer):
    """Ephemeral activity-room presence and notification transport.

    This consumer deliberately has no business mutation command. Formal changes
    remain HTTP service calls; this socket only carries presence metadata and
    post-commit notifications that cause the browser to refetch authoritative
    state.
    """

    async def connect(self) -> None:
        user = self.scope.get("user")
        if not isinstance(user, User) or not user.is_authenticated or not user.is_staff_or_admin:
            await self.close(code=4403)
            return

        activity_id = self.scope.get("url_route", {}).get("kwargs", {}).get("activity_id")
        if not isinstance(activity_id, int) or not await self._activity_exists(activity_id):
            await self.close(code=4404)
            return

        self.activity_id = activity_id
        self.room = f"staff_activity_{activity_id}"
        self.client_id = self._requested_client_id()
        self.presence_store = redis_presence_store(self.room)
        self.member = PresenceMember(
            client_id=self.client_id,
            user_id=user.pk,
            display=user.get_username(),
        )

        await self.channel_layer.group_add(self.room, self.channel_name)
        await self.accept()
        await self._put_presence()
        await self.send_json(
            {
                "type": "presence.snapshot",
                "resource": f"activity:{activity_id}",
                "members": await self._presence_snapshot(),
            }
        )
        await self.channel_layer.group_send(
            self.room,
            {
                "type": "realtime.presence",
                "event": "presence.join",
                "resource": f"activity:{activity_id}",
                "member": self.member.as_dict(),
                "origin": self.client_id,
            },
        )

    async def disconnect(self, code: int | None = None) -> None:
        if not hasattr(self, "room"):
            return
        if getattr(self, "presence_store", None) is not None:
            try:
                await self.presence_store.remove(self.client_id)
            except Exception:
                pass
        try:
            await self.channel_layer.group_send(
                self.room,
                {
                    "type": "realtime.presence",
                    "event": "presence.leave",
                    "resource": f"activity:{self.activity_id}",
                    "client_id": self.client_id,
                    "origin": self.client_id,
                },
            )
            await self.channel_layer.group_discard(self.room, self.channel_name)
        finally:
            if getattr(self, "presence_store", None) is not None:
                try:
                    await self.presence_store.close()
                except Exception:
                    pass

    async def receive_json(self, content: dict[str, Any], **kwargs: Any) -> None:
        message_type = content.get("type")
        if message_type == "heartbeat":
            await self._put_presence()
            return
        if message_type == "presence.focus":
            path = content.get("path", "")
            if not isinstance(path, str) or len(path) > _PATH_MAX_LENGTH:
                await self.send_json({"type": "error", "code": "INVALID_PRESENCE_PATH"})
                return
            self.member = PresenceMember(
                client_id=self.member.client_id,
                user_id=self.member.user_id,
                display=self.member.display,
                path=path,
            )
            await self._put_presence()
            await self._broadcast_presence("presence.focus")
            return
        if message_type == "presence.blur":
            self.member = PresenceMember(
                client_id=self.member.client_id,
                user_id=self.member.user_id,
                display=self.member.display,
            )
            await self._put_presence()
            await self._broadcast_presence("presence.blur")
            return
        await self.send_json({"type": "error", "code": "UNSUPPORTED_REALTIME_MESSAGE"})

    async def realtime_presence(self, event: dict[str, Any]) -> None:
        if event.get("origin") == self.client_id and event.get("event") != "presence.join":
            return
        payload = {
            "type": event.get("event", "presence.update"),
            "resource": event.get("resource", f"activity:{self.activity_id}"),
        }
        if "member" in event:
            payload["member"] = event["member"]
        if "client_id" in event:
            payload["client_id"] = event["client_id"]
        await self.send_json(payload)

    async def realtime_event(self, event: dict[str, Any]) -> None:
        """Forward a post-commit invalidation without embedding business state."""
        payload: dict[str, Any] = {
            "type": event["event"],
            "resource": event["resource"],
            "revision": event.get("revision"),
            "actor": event.get("actor"),
        }
        details = event.get("details")
        if isinstance(details, dict):
            payload.update(details)
        await self.send_json(payload)

    async def _broadcast_presence(self, event_name: str) -> None:
        await self.channel_layer.group_send(
            self.room,
            {
                "type": "realtime.presence",
                "event": event_name,
                "resource": f"activity:{self.activity_id}",
                "member": self.member.as_dict(),
                "origin": self.client_id,
            },
        )

    async def _put_presence(self) -> None:
        if self.presence_store is not None:
            try:
                await self.presence_store.put(self.member)
            except Exception:
                # Redis is an enhancement dependency. HTTP mutation and the
                # socket itself remain usable when a transient heartbeat fails.
                pass

    async def _presence_snapshot(self) -> list[dict[str, int | str]]:
        if self.presence_store is None:
            return [self.member.as_dict()]
        try:
            return await self.presence_store.snapshot()
        except Exception:
            return [self.member.as_dict()]

    def _requested_client_id(self) -> str:
        raw = self.scope.get("query_string", b"").decode("ascii", errors="ignore")
        for item in raw.split("&"):
            key, separator, value = item.partition("=")
            if key == "client_id" and separator and _CLIENT_ID_PATTERN.fullmatch(value):
                return value
        return self.channel_name.replace("!", "-")

    @sync_to_async
    def _activity_exists(self, activity_id: int) -> bool:
        try:
            return Activity.objects.filter(pk=activity_id).exists()
        except PermissionDenied:
            return False


class JudgeContextConsumer(AsyncJsonWebsocketConsumer):
    """Push-only invalidation channel for the authenticated judge terminal.

    The browser sends no round, seat, or business mutation through this socket.
    The HttpOnly judge session cookie is resolved server-side and the complete
    context is still fetched through the authoritative HTTP endpoint.
    """

    async def connect(self) -> None:
        token = self._judge_cookie()
        if not token:
            await self.close(code=4401)
            return
        try:
            context = await self._load_context(token)
        except (PermissionDenied, ValidationError):
            await self.close(code=4401)
            return

        self.room = f"judge_round_{context.round_id}"
        await self.channel_layer.group_add(self.room, self.channel_name)
        await self.accept()
        await self.send_json(
            {
                "type": "realtime.ready",
                "resource": f"judge-context:{context.round_id}",
                "revision": context.context_version,
            }
        )

    async def disconnect(self, code: int | None = None) -> None:
        if hasattr(self, "room"):
            await self.channel_layer.group_discard(self.room, self.channel_name)

    async def receive_json(self, content: dict[str, Any], **kwargs: Any) -> None:
        if content.get("type") == "heartbeat":
            return
        await self.send_json({"type": "error", "code": "UNSUPPORTED_REALTIME_MESSAGE"})

    async def realtime_event(self, event: dict[str, Any]) -> None:
        await self.send_json(
            {
                "type": event["event"],
                "resource": event["resource"],
                "revision": event.get("revision"),
                "actor": event.get("actor"),
            }
        )

    def _judge_cookie(self) -> str | None:
        raw_cookie = next(
            (value for key, value in self.scope.get("headers", []) if key == b"cookie"),
            b"",
        )
        if not raw_cookie:
            return None
        cookies = SimpleCookie()
        try:
            cookies.load(raw_cookie.decode("latin-1"))
        except (TypeError, ValueError):
            return None
        morsel = cookies.get("artflow_judge_session")
        value = morsel.value if morsel is not None else ""
        return value or None

    @sync_to_async
    def _load_context(self, token: str):
        from singer_contest.judge_authority import get_judge_context_readonly

        return get_judge_context_readonly(token)


class GroupMaterialConsumer(AsyncJsonWebsocketConsumer):
    """Presence and invalidation room for one Group Chorus material workspace."""

    async def connect(self) -> None:
        user = self.scope.get("user")
        if not isinstance(user, User) or not user.is_authenticated:
            await self.close(code=4403)
            return
        group_id = self.scope.get("url_route", {}).get("kwargs", {}).get("group_id")
        if not isinstance(group_id, int):
            await self.close(code=4404)
            return
        group = await self._load_group(group_id, user.pk)
        if group is None:
            await self.close(code=4403)
            return
        self.group_id = group_id
        self.activity_id = group["activity_id"]
        self.room = f"group_material_{group_id}"
        self.client_id = self._requested_client_id()
        self.presence_store = redis_presence_store(self.room)
        self.member = PresenceMember(
            client_id=self.client_id,
            user_id=user.pk,
            display=user.get_username(),
        )
        await self.channel_layer.group_add(self.room, self.channel_name)
        await self.accept()
        await self._put_presence()
        await self.send_json(
            {
                "type": "presence.snapshot",
                "resource": f"group:{group_id}:materials",
                "members": await self._presence_snapshot(),
            }
        )
        await self._broadcast_presence("presence.join")

    async def disconnect(self, code: int | None = None) -> None:
        if not hasattr(self, "room"):
            return
        try:
            if getattr(self, "presence_store", None) is not None:
                await self.presence_store.remove(self.client_id)
            await self._broadcast_presence("presence.leave")
            await self.channel_layer.group_discard(self.room, self.channel_name)
        except Exception:
            pass
        finally:
            if getattr(self, "presence_store", None) is not None:
                try:
                    await self.presence_store.close()
                except Exception:
                    pass

    async def receive_json(self, content: dict[str, Any], **kwargs: Any) -> None:
        message_type = content.get("type")
        if message_type == "heartbeat":
            await self._put_presence()
            return
        if message_type in {"presence.focus", "presence.blur"}:
            path = content.get("path", "") if message_type == "presence.focus" else ""
            if not isinstance(path, str) or len(path) > _PATH_MAX_LENGTH:
                await self.send_json({"type": "error", "code": "INVALID_PRESENCE_PATH"})
                return
            self.member = PresenceMember(
                client_id=self.member.client_id,
                user_id=self.member.user_id,
                display=self.member.display,
                path=path,
            )
            await self._put_presence()
            await self._broadcast_presence(message_type)
            return
        await self.send_json({"type": "error", "code": "UNSUPPORTED_REALTIME_MESSAGE"})

    async def realtime_presence(self, event: dict[str, Any]) -> None:
        if event.get("origin") == self.client_id and event.get("event") != "presence.join":
            return
        payload = {
            "type": event.get("event", "presence.update"),
            "resource": f"group:{self.group_id}:materials",
        }
        if "member" in event:
            payload["member"] = event["member"]
        await self.send_json(payload)

    async def realtime_event(self, event: dict[str, Any]) -> None:
        payload = {
            "type": event["event"],
            "resource": event["resource"],
            "revision": event.get("revision"),
            "actor": event.get("actor"),
        }
        details = event.get("details")
        if isinstance(details, dict):
            payload.update(details)
        await self.send_json(payload)

    async def _broadcast_presence(self, event_name: str) -> None:
        await self.channel_layer.group_send(
            self.room,
            {
                "type": "realtime.presence",
                "event": event_name,
                "resource": f"group:{self.group_id}:materials",
                "member": self.member.as_dict(),
                "origin": self.client_id,
            },
        )

    async def _put_presence(self) -> None:
        if self.presence_store is not None:
            try:
                await self.presence_store.put(self.member)
            except Exception:
                pass

    async def _presence_snapshot(self) -> list[dict[str, int | str]]:
        if self.presence_store is None:
            return [self.member.as_dict()]
        try:
            return await self.presence_store.snapshot()
        except Exception:
            return [self.member.as_dict()]

    def _requested_client_id(self) -> str:
        raw = self.scope.get("query_string", b"").decode("ascii", errors="ignore")
        for item in raw.split("&"):
            key, separator, value = item.partition("=")
            if key == "client_id" and separator and _CLIENT_ID_PATTERN.fullmatch(value):
                return value
        return self.channel_name.replace("!", "-")

    @sync_to_async
    def _load_group(self, group_id: int, user_id: int) -> dict[str, int] | None:
        from singer_contest.models import Group

        group = (
            Group.objects.select_related("stage__activity")
            .filter(pk=group_id, is_active=True)
            .first()
        )
        if group is None:
            return None
        user = User.objects.filter(pk=user_id).first()
        if user is None or user.is_staff_or_admin:
            return {"activity_id": group.stage.activity_id}
        if group.memberships.filter(is_current=True, singer__user_id=user_id).exists():
            return {"activity_id": group.stage.activity_id}
        return None
