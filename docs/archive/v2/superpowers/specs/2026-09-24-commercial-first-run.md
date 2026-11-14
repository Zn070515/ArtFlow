# Commercial First-Run Provisioning Specification

**Status:** Accepted for P0-C implementation

## Goal

Allow a purchaser to create the one and only initial ArtFlow administrator from a browser after starting the event runtime, without exposing an unauthenticated administrator-creation mutation or changing any competition authority.

## User flow

1. The event launcher prints `http://127.0.0.1:<port>/setup/` as the one-time setup address.
2. A purchaser opens the address while installation state is `required`.
3. The setup form asks for username, password, password confirmation, and the configured `ADMIN_LOGIN_KEY`.
4. A valid submission calls the existing `accounts.services.provision_first_admin()` service.
5. On success the browser signs the new administrator in with an elevated admin session and redirects to Staff.
6. After success the setup endpoint is unavailable and cannot reset, replace, or create another administrator.

## Security contract

- GET never mutates installation state.
- POST requires Django CSRF protection, the configured `ADMIN_LOGIN_KEY`, and the existing per-client rate-limit boundary.
- The setup key is compared in constant time and is never written to an audit row, response, or log.
- A missing or known placeholder `ADMIN_LOGIN_KEY` fails closed; the setup page cannot bootstrap from a sample credential.
- The endpoint is available only while `installation_provisioning_status()` is `required`; `complete` and `inconsistent` states do not expose the form.
- All administrator creation remains inside `provision_first_admin()` and its account authority transaction. The view never writes `User` or `InstallationState` directly.
- Password fields are never redisplayed after submission and passwords are never included in messages, audit data, or logs.
- A successful setup uses Django session rotation through `login()` and the existing `mark_admin_verified()` helper; no superuser is created.
- The event launcher remains loopback by default. LAN mode remains an explicit opt-in and is not changed by this feature.

## Compatibility contract

- The existing CLI `provision_first_admin` command remains available for technical recovery and production operations.
- Existing admin login, rate limiting, audit, and authority tests remain valid.
- No model, migration, ruleset, scoring, result, permission, release, or public publication behavior changes.
- No new environment variable is introduced; `ADMIN_LOGIN_KEY` is the already-required deployment secret.

## Acceptance criteria

1. Required installations render a CSRF-protected setup form without displaying secrets.
2. Missing, placeholder, or incorrect setup keys cannot create an administrator.
3. Invalid password confirmation and password-policy failures cannot create an administrator.
4. A valid submission creates exactly one role-based, non-superuser administrator, records the existing bootstrap audit event, signs the user in, and redirects to Staff.
5. Concurrent or repeated submissions remain one-time because the existing service remains the authority boundary.
6. Completed and inconsistent installations fail closed without rendering the setup form.
7. Repeated setup attempts are rate limited using the shared rate-limit backend.
8. The launcher and purchaser documentation expose the browser flow without adding reset, volume deletion, firewall, tunnel, or public-ingress behavior.

## Non-goals

- Native installer, licensing, DRM, machine binding, or payment integration.
- Anonymous administrator creation without the deployment key.
- Automatic secret generation, `.env` writes, or automatic firewall changes.
- Changes to ArtFlow competition workflows or authority semantics.
