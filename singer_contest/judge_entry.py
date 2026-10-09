"""The judge entry capability: what a shared judge QR has to carry.

GOAL §12.3 replaced one QR per seat with one stable QR the whole panel shares. The
entry itself was left as the plain public activity route, which made the *first*
JudgeSession free: `/e/<public_code>/judge/` is a public URL, the public activity page
linked to it, and `judge_claim` asked only for the activity — so anyone who could read the
public code could take a seat and, from there, submit a formal `DIRECT_JUDGE` score that
every downstream guard would accept as legitimate, because it *was* legitimate: a real
seat, a real panel, a real session. The authority after the door was never the problem;
the door was.

This module is the door. A capability is an HMAC over the activity's public code and its
`judge_entry_version`, domain-separated from the ticket credential so neither can be
replayed as the other:

    AF1.J.<public_code>.<version>.<signature>

It travels in the URL **fragment** (`/e/<code>/judge/#AF1.J...`), which the browser never
sends to the server: it stays out of access logs, out of `Referer`, and out of the HTML the
page renders. The terminal reads it, clears it from the address bar, and presents it once
when it claims a seat.

Rotating is a version bump, so a printed code can be killed without closing the entry —
closing also turns away a teacher who is simply late.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any

from core.models import Activity
from django.conf import settings

# `AF1` is the artifact family (the ticket credential is `AF1.T...`); the second segment is
# the kind, and the whole prefix is inside the signed message so a ticket credential can
# never validate as a judge capability even though both are keyed on the same secret.
JUDGE_ENTRY_ISSUER = "AF1"
JUDGE_ENTRY_KIND = "J"
JUDGE_ENTRY_PREFIX = f"{JUDGE_ENTRY_ISSUER}.{JUDGE_ENTRY_KIND}"
_SIGNATURE_LENGTH = 32


def judge_entry_signature(public_code: str, version: int) -> str:
    """The domain-separated digest for one activity's judge entry at one version.

    The prefix is inside the signed message, not just in the rendered string, so a ticket
    credential and a judge-entry capability can never be valid for one another even though
    both are keyed on the same server secret.
    """
    message = f"{JUDGE_ENTRY_PREFIX}.{public_code}.{version}".encode("ascii")
    return hmac.new(settings.QR_SIGNING_KEY.encode("utf-8"), message, hashlib.sha256).hexdigest()[
        :_SIGNATURE_LENGTH
    ]


def judge_entry_credential(activity: Activity) -> str:
    """The capability a judge QR for *activity* carries, at its current version."""
    if not activity.public_code:
        raise ValueError("A judge entry capability needs an activity public code.")
    version = activity.judge_entry_version
    signature = judge_entry_signature(activity.public_code, version)
    return f"{JUDGE_ENTRY_PREFIX}.{activity.public_code}.{version}.{signature}"


def _parse_credential(raw_credential: Any) -> tuple[str, int, str] | None:
    """Split ``AF1.J.<code>.<version>.<signature>`` into its claim, or return ``None``.

    Five parts, the same shape as the ticket credential (``AF1.T....``): the type letter is
    what tells the two apart, and it is inside the signed message, so neither can be
    replayed as the other.
    """
    if not isinstance(raw_credential, str):
        return None
    parts = raw_credential.split(".")
    if len(parts) != 5 or parts[0] != JUDGE_ENTRY_ISSUER or parts[1] != JUDGE_ENTRY_KIND:
        return None
    _, _, public_code, version_text, signature = parts
    if not public_code.isalnum() or not version_text.isdigit():
        return None
    return public_code, int(version_text), signature


def judge_entry_authorizes_activity(raw_credential: Any, locked_activity: Activity) -> bool:
    """Whether *raw_credential* is the capability ``locked_activity`` issues **right now**.

    This is the check that has to run after the activity row lock, because the capability
    is resolved before the lock can be taken and staff can reissue or close the entry in
    between. Without it, "reissuing invalidates the code that was already handed out" and
    "closing refuses new scans" are both only true for requests that *start* after the
    change — a claim that had already resolved the old code would still take a seat,
    exactly the shape the ticket credential had.

    The version is read from the locked row and compared against the token's claim, then the
    signature is recomputed from the row; a rotation therefore invalidates every previously
    issued code at the instant it commits.
    """
    parsed = _parse_credential(raw_credential)
    if parsed is None:
        return False
    token_public_code, token_version, signature = parsed
    if token_public_code != locked_activity.public_code:
        return False
    if token_version != locked_activity.judge_entry_version:
        return False
    expected = judge_entry_signature(
        locked_activity.public_code, locked_activity.judge_entry_version
    )
    return hmac.compare_digest(signature, expected)


def judge_entry_activity(raw_credential: Any, *, public_code: str) -> Activity | None:
    """Resolve a capability to the activity it was issued for, or ``None``.

    The *pre-lock* lookup: it names the row to lock, and the caller must revalidate against
    that row afterwards with :func:`judge_entry_authorizes_activity`. ``public_code`` is the
    one named in the request path, and the capability has to name the same activity, so a
    token for another contest does not open this door even when the same staff run both.
    """
    parsed = _parse_credential(raw_credential)
    if parsed is None:
        return None
    token_public_code, version, signature = parsed
    if token_public_code != public_code:
        return None
    if not hmac.compare_digest(signature, judge_entry_signature(public_code, version)):
        return None
    return Activity.objects.filter(
        public_code=public_code,
        activity_type=Activity.Type.SINGER_CONTEST,
        judge_entry_version=version,
    ).first()
