from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from time import monotonic
from typing import Protocol

from django.conf import settings

PRESENCE_TTL_SECONDS = 45
_memory_lock = asyncio.Lock()
_memory_records: dict[tuple[str, str], tuple[float, dict[str, int | str]]] = {}


@dataclass(frozen=True)
class PresenceMember:
    """Ephemeral collaboration metadata; it is never persisted in PostgreSQL."""

    client_id: str
    user_id: int
    display: str
    path: str = ""

    def as_dict(self) -> dict[str, int | str]:
        return {
            "client_id": self.client_id,
            "user_id": self.user_id,
            "display": self.display,
            "path": self.path,
        }


class PresenceStore(Protocol):
    async def put(self, member: PresenceMember) -> None: ...

    async def remove(self, client_id: str) -> None: ...

    async def snapshot(self) -> list[dict[str, int | str]]: ...

    async def close(self) -> None: ...


class MemoryPresenceStore:
    """Development/test fallback when no realtime Redis URL is configured."""

    def __init__(self, room: str) -> None:
        self._room = room

    async def put(self, member: PresenceMember) -> None:
        async with _memory_lock:
            _prune_memory_locked()
            _memory_records[(self._room, member.client_id)] = (
                monotonic() + PRESENCE_TTL_SECONDS,
                member.as_dict(),
            )

    async def remove(self, client_id: str) -> None:
        async with _memory_lock:
            _memory_records.pop((self._room, client_id), None)

    async def snapshot(self) -> list[dict[str, int | str]]:
        async with _memory_lock:
            _prune_memory_locked()
            members = [
                value for (room, _), (_, value) in _memory_records.items() if room == self._room
            ]
        members.sort(key=lambda value: (str(value.get("display", "")), str(value["client_id"])))
        return members

    async def close(self) -> None:
        return


def _prune_memory_locked() -> None:
    now = monotonic()
    for key, (expires_at, _) in list(_memory_records.items()):
        if expires_at <= now:
            del _memory_records[key]


class RedisPresenceStore:
    """Short-lived presence records backed by the realtime Redis instance."""

    def __init__(self, redis_url: str, room: str) -> None:
        from redis.asyncio import Redis

        self._redis = Redis.from_url(redis_url, decode_responses=True)
        self._room = room

    def _key(self, client_id: str) -> str:
        return f"artflow:presence:{self._room}:{client_id}"

    async def put(self, member: PresenceMember) -> None:
        await self._redis.set(
            self._key(member.client_id),
            json.dumps(member.as_dict(), ensure_ascii=False, separators=(",", ":")),
            ex=PRESENCE_TTL_SECONDS,
        )

    async def remove(self, client_id: str) -> None:
        await self._redis.delete(self._key(client_id))

    async def snapshot(self) -> list[dict[str, int | str]]:
        members: list[dict[str, int | str]] = []
        pattern = f"artflow:presence:{self._room}:*"
        async for key in self._redis.scan_iter(match=pattern, count=100):
            raw = await self._redis.get(key)
            if not raw:
                continue
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and isinstance(value.get("client_id"), str):
                members.append(value)
        members.sort(key=lambda value: (str(value.get("display", "")), str(value["client_id"])))
        return members

    async def close(self) -> None:
        await self._redis.aclose()


def redis_presence_store(room: str) -> PresenceStore:
    redis_url = str(getattr(settings, "REALTIME_REDIS_URL", "")).strip()
    if not redis_url:
        return MemoryPresenceStore(room)
    return RedisPresenceStore(redis_url, room)
