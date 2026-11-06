# ADR-0017: Cookie sessions, CSRF, and the participant registration loop

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

Web authentication uses an HttpOnly `artflow_session` cookie plus a readable
`artflow_csrf` cookie. Both are `SameSite=Strict` and `Path=/`; production adds
`Secure`. The session token remains in the database (`local_session`) and is
never stored in browser storage.

CSRF is bound to the session: `HMAC-SHA256(credentialSecret, "csrf:" +
sessionToken)`. Mutating requests with the session cookie must send the matching
`x-csrf-token` header. Bearer clients are exempt, as are login, register, and
logout. `GET /api/auth/me` returns the actor and the current CSRF token;
`POST /api/auth/logout` revokes the session and clears both cookies.

Participants self-register through `POST /api/auth/register` (username 3-64,
password 8-128, 5/min/IP). The actor id is opaque (`participant:<uuid>`) and the
account has no permissions. Open self-registration is a product choice; an
invite code or email verification can be added later.

The registration loop reads the questionnaire frozen into the registration's
release, not the current activity definition. Participants can enter a public
code, start/resume their registration, save text answers, register material
metadata, and submit. Ops can list activities, list registrations, read the
frozen form, approve/request supplement/reject, and finalize the roster.

Material rows are metadata-only (name/content-type/size). No bytes are stored or
served in this slice; the UI says so explicitly. The media byte gateway is a
separate slice and must not be implied by the current registration UI.

## Alternatives rejected

- Bearer tokens in localStorage/sessionStorage: readable by XSS and requires
  manual refresh handling; cookies are the same-origin default.
- Admin-provisioned participant accounts: blocks self-service registration and
  adds operational work for every participant.
- Storing file bytes before the media gateway: would require a storage adapter,
  range serving, and retention semantics in the same slice.
- Putting the questionnaire in the activity response: registrations must keep
  their frozen version; the read endpoint resolves by questionnaire hash.

## Consequences

- Web and API must be same-origin behind the Vite proxy or a production reverse
  proxy; cookies do not work across origins.
- Production must set `ARTFLOW_PLUS_CREDENTIAL_SECRET`; the API fails at startup
  otherwise.
- The in-memory registration rate limiter is single-process; multi-instance
  production needs a shared limiter.
- The E2E seed resets only its own registration activity data and uses a
  disposable `artflow_e2e` schema.
