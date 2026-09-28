# Global UX Safety Implementation Plan

> **For implementation:** execute inline in the repository checkout, without subagents or linked worktrees. Keep each logical change in a small conventional commit.

**Goal:** Give the application consistent severity-aware feedback, a usable mobile navigation, and safe custom error pages without changing domain behavior.

**Scope:** `templates/base.html`, shared CSS/source assets, error handlers/templates, and focused template/HTTP tests. Do not redesign dashboards or introduce a full design system.

## Tasks

1. Add failing tests for message severity classes/icons and `role="alert"`, mobile navigation semantics, and custom 403/404/500 wording that does not encourage resubmitting sensitive forms.
2. Add shared message presentation with Django message tags mapped to stable visual severity, accessible labels, and safe text-only rendering.
3. Add a keyboard/mobile navigation control that works without JavaScript and preserves the existing desktop navigation.
4. Add custom 403/404/500 templates and URL handlers. Ensure the 500 page is generic and does not expose exception details or suggest repeating a sensitive submission.
5. Run focused template/HTTP tests and asset checks, then commit the independently verified change.

## Verification

- `python manage.py test tests.test_check_docs`
- `python manage.py test public_portal accounts`
- `python manage.py check`
- `npm run check:css`

## Self-review checklist

- Message content remains escaped and no secret/request data is rendered.
- Error pages do not disclose stack traces, model identifiers, or credentials.
- Navigation remains usable with JavaScript disabled and at narrow widths.
- No unrelated dashboard or design-system rewrite is included.
