# Commercial Event Runtime Specification

**Status:** Accepted for P0-B implementation; first-run setup non-goal superseded by P0-C

> P0-B deliberately shipped without an HTTP first-run setup route. The accepted
> P0-C specification (`2026-09-24-commercial-first-run.md`) now adds a
> one-time route protected by `ADMIN_LOGIN_KEY`, CSRF, rate limiting, and the
> existing account authority service. All other P0-B non-goals remain in force.

## Goal

Provide a self-service Windows/Docker event runtime entry point for ArtFlow without changing competition business behavior or weakening the default loopback-only deployment posture.

## User contract

The purchaser receives a tracked `.env.event.example`, copies it to an untracked `.env.event`, fills the required secrets, and runs:

```powershell
pwsh -NoProfile -File scripts/start-event.ps1
```

This starts the event stack on `127.0.0.1:8000` by default, waits for healthy services, runs read-only diagnostics, checks `/healthz/`, and prints the Staff URL.

For phones on the same private LAN, the purchaser must explicitly opt in:

```powershell
pwsh -NoProfile -File scripts/start-event.ps1 -Lan
```

The launcher detects one usable non-loopback IPv4 address, binds the published web port to all host interfaces, adds only that detected address to Django `ALLOWED_HOSTS`, runs the same diagnostics, and prints the LAN URL. `-HostAddress` overrides detection when the computer has multiple network adapters.

## Security contract

- The default event bind address remains `127.0.0.1`.
- LAN exposure requires the explicit `-Lan` switch; the launcher never enables it implicitly.
- The database has no host-published port in either mode.
- The launcher validates port and host-address inputs before using them in Compose interpolation.
- The launcher never writes secrets, passwords, tokens, or generated environment files.
- The launcher never runs `docker compose down --volumes`, reset commands, or database deletion commands.
- No public tunnel, TLS claim, Internet ingress, or DDoS protection is introduced by this feature.
- Windows Firewall is not silently modified. Documentation tells the user to allow Docker Desktop on Private networks if Windows prompts for it.
- `ALLOWED_HOSTS` is derived from the selected mode; arbitrary caller-provided host lists are not accepted by the launcher.
- The event runtime continues to use `RATE_LIMIT_BACKEND=database` and PostgreSQL.

## Runtime interface

`deploy/compose.event.yml` consumes these launcher-only interpolation variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARTFLOW_EVENT_BIND_ADDRESS` | `127.0.0.1` | Host bind address for the web port |
| `ARTFLOW_EVENT_PORT` | `8000` | Host port, constrained to 1024–65535 by the launcher |
| `ARTFLOW_EVENT_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Exact Django host list selected by the launcher |

The container always listens on port `8000`; only the host-side publication changes.

## Diagnostics contract

After `docker compose up --build --wait`, the launcher must run:

```text
docker compose exec -T web python manage.py doctor
GET http://127.0.0.1:<selected-port>/healthz/
```

It must fail on a non-zero diagnostic or health result and must print no secret values. A successful run prints the local Staff URL and, in LAN mode, the selected LAN URL.

## Non-goals

- No anonymous first-run HTTP setup route.
- No licensing, activation, DRM, or machine binding.
- No new competition models, scoring rules, result authority, permissions, or public release behavior.
- No automatic Windows Firewall rule creation.
- No production HTTPS replacement; production remains `deploy/compose.production.yml` with Caddy.

## Acceptance criteria

1. A fresh copy of `.env.event.example` is clearly documented and contains no real credentials.
2. Existing loopback event Compose behavior remains valid by default.
3. `-Lan` produces a LAN-capable Compose configuration only through explicit process-local variables.
4. Invalid ports, loopback host overrides, APIPA addresses, and malformed host addresses fail before Docker starts.
5. The launcher runs `up --build --wait`, `doctor`, and health verification, preserving volumes.
6. Static contract tests cover the script and manifest security boundaries.
7. Existing Django, Pyright, client, documentation, Docker, and remote CI gates remain green.
