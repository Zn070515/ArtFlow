# Auth Entry Boundaries Implementation Plan

> **For implementation:** execute inline in the repository checkout, without subagents or linked worktrees. Keep each logical change in a small conventional commit.

**Goal:** Make authentication entry points explicit and enforce the participant/staff/admin role matrix without leaking role existence or weakening `next=` safety.

**Scope:** `accounts` URLs, views, forms, decorators, auth templates, and focused auth tests. Preserve existing role semantics and administrator verification.

## Tasks

1. Add failing tests for the GET-only selector, participant/staff/admin destinations, legacy `/admin-login/` redirect, same-host `next=`, and role mismatch behavior after valid credentials.
2. Add canonical participant and staff login routes, keep `accounts:login` as the selector, and make legacy admin login redirect to the canonical admin form while preserving a safe `next=` value.
3. Implement role-specific authentication forms/views and decorator redirects. Keep invalid credentials generic; only a valid credential pair may reveal that the selected role is wrong.
4. Replace auth templates' implicit form rendering with explicit accessible fields and role-specific copy, including the registration label “选手注册”.
5. Run focused Django auth/decorator tests, inspect redirect targets and audit behavior, then commit the independently verified change.

## Verification

- `python manage.py test accounts staff_panel.tests.AdminAuthBoundaryTests`
- `python manage.py test accounts`
- `python manage.py check`
- `npm run check:pyright`
- `npm run check:pyright:entry-access`

## Self-review checklist

- No role is accepted by the wrong canonical login form.
- Anonymous staff/admin redirects preserve a same-host `next=` only.
- No password, admin key, or raw credential is echoed in HTML, redirects, or logs.
- Existing admin verification and audit behavior remains intact.
