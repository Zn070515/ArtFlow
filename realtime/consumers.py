from __future__ import annotations

import re
from typing import Any

from accounts.models import User
from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from core.models import Activity
from django.core.exceptions import PermissionDenied

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

    async def disconnect(self, close_code: int) -> None:
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
        await self.send_json(
            {
                "type": event["event"],
                "resource": event["resource"],
                "revision": event.get("revision"),
                "actor": event.get("actor"),
            }
        )

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
