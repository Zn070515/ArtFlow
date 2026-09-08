# M2-B-FINAL Ticket Operator Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** Close the M2-B ticket vertical slice so staff can issue, batch-issue, display, search, check in, inspect, void, and revoke tickets through an authenticated operator surface, while the public scanner reports the ticket's actual eligibility state.

**Architecture:** Keep the existing JSON endpoints as stable machine/API contracts and add server-rendered staff pages around the same audited ticket services. Batch issuance is an atomic domain service that returns raw secrets only to the issuing response; list/detail pages expose state and metadata but never secrets or digests. Public redemption returns a non-sensitive `ticket_state` so the TypeScript scanner can distinguish “identified but not checked in” from “checked in”.

**Tech Stack:** Django 6, Django templates, existing `tickets.services` authority services, qrcode/Pillow for in-memory QR PNG data URIs, TypeScript client build, Django `TestCase`.

**Spec:** `GOAL.md` sections 3.5, 4.2, and 5; `docs/production-readiness.md` M2-B requirements; `C:\Users\16275\Desktop\advices\ChatGPT.md` section “M2-B-FINAL — Ticket Operator Surface”.

## Global Constraints

- Ticket state and ticket-session state may change only through audited ticket services under their authority scopes.
- Raw ticket secrets are returned only at issue time and must never appear in list/detail pages, audit values, logs, or URLs outside the intended QR fragment.
- Public redemption remains body-only POST and must keep `Cache-Control: no-store`.
- Staff pages require `staff_required`; void/revoke remain admin-only operations.
- Existing JSON URLs and response status codes remain backward compatible; new fields may be additive.
- Every logical change is a small conventional commit with its focused gate run before commit.

---

### Task 1: Make public ticket eligibility state explicit

**Files:**
- Modify: `tickets/views.py:redeem`
- Modify: `frontend/ticket_scan.ts`
- Test: `tickets/tests.py:TicketPublicHttpTests`, `tests/client/ticket_scan.test.mjs`

**Interfaces:**
- `POST /tickets/redeem/` keeps its status and cookie contract and adds `ticket_state` with values `issued` or `checked_in`.
- The scanner renders `issued` as “票据已识别。完成现场检票后获得投票资格。” and `checked_in` as “已完成现场检票。你已具备票券投票资格，具体以当前投票场次状态为准。”

- [ ] **Step 1: Write the failing tests.**

```python
redeemed = csrf_client.post(
    "/tickets/redeem/",
    data=json.dumps({"secret": self.issued.secret}),
    content_type="application/json",
    HTTP_X_CSRFTOKEN=csrf_token,
)
self.assertEqual(redeemed.json()["ticket_state"], "issued")
```

Add a checked-in fixture and assert `ticket_state == "checked_in"`. Add client assertions that the two states render different messages and that the old unconditional success copy is absent.

- [ ] **Step 2: Run the focused tests and verify RED.**

Run:

```bash
uv run python manage.py test tickets.tests.TicketPublicHttpTests
node --test tests/client/ticket_scan.test.mjs
```

Expected: the server response has no `ticket_state`, and the client still uses the old unconditional message.

- [ ] **Step 3: Implement the additive response and state-aware client.**

Return `result.session.ticket.state` from `tickets.views.redeem` and replace the single success string with a `ticketStateMessage` function keyed only by `issued` and `checked_in`; unknown successful states must use the generic failure message.

- [ ] **Step 4: Run the focused tests and client build.**

```bash
uv run python manage.py test tickets.tests.TicketPublicHttpTests
npm run check:client
npm run test:client
```

- [ ] **Step 5: Commit.**

```bash
git add tickets/views.py tickets/tests.py frontend/ticket_scan.ts tests/client/ticket_scan.test.mjs static/dist/ticket_scan.js
git commit -m "fix: report ticket eligibility state to audience"
```

### Task 2: Add an atomic batch ticket issuance service

**Files:**
- Modify: `tickets/services.py`
- Test: `tickets/tests.py:TicketLifecycleServiceTests`

**Interfaces:**
- Add `issue_ticket_batch(activity, actor, quantity, batch_reference, serial_prefix) -> list[IssuedTicket]`.
- `quantity` is an integer from 1 through 100; generated serials are `serial_prefix-001`, `serial_prefix-002`, etc. A single ticket may omit the prefix and serial.
- The operation locks the activity, rejects existing `(activity, batch_reference, serial_number)` inventory collisions before mutation, and wraps creation/issuance in one transaction.

- [ ] **Step 1: Write failing service tests.**

```python
issued = issue_ticket_batch(
    self.activity,
    actor=self.staff,
    quantity=3,
    batch_reference="GATE-A",
    serial_prefix="A",
)
self.assertEqual([item.ticket.serial_number for item in issued], ["A-001", "A-002", "A-003"])
self.assertEqual({item.ticket.state for item in issued}, {Ticket.State.ISSUED})
self.assertEqual(len({item.secret for item in issued}), 3)
```

Also test quantity bounds, duplicate inventory rejection with no partial rows, and that a participant cannot invoke the service.

- [ ] **Step 2: Run the focused service tests and verify RED.**

```bash
uv run python manage.py test tickets.tests.TicketLifecycleServiceTests
```

Expected: import failure because `issue_ticket_batch` does not exist.

- [ ] **Step 3: Implement the minimal atomic service.**

Validate the quantity and normalized batch/prefix before opening the transaction. Inside `transaction.atomic()`, lock the activity through `lock_activity_for_action`, calculate serials, reject existing rows, create each `CREATED` ticket under `TICKET_STATE`, and issue each ticket through the existing audited service. Do not return or persist any raw secret except in the `IssuedTicket` return objects.

- [ ] **Step 4: Run service and authority regression tests.**

```bash
uv run python manage.py test tickets.tests.TicketLifecycleServiceTests tickets.tests.TicketModelContractTests
```

- [ ] **Step 5: Commit.**

```bash
git add tickets/services.py tickets/tests.py
git commit -m "feat: add atomic batch ticket issuance"
```

### Task 3: Build authenticated ticket operator pages

**Files:**
- Modify: `tickets/views.py`
- Modify: `tickets/staff_urls.py`
- Modify: `templates/staff_panel/ticket_list.html`
- Modify: `templates/staff_panel/ticket_issue.html`
- Modify: `templates/staff_panel/ticket_check_in.html`
- Modify: `templates/staff_panel/ticket_detail.html`
- Test: `tickets/tests.py:TicketStaffHttpTests`

**Interfaces:**
- Add named pages `ticket_staff:list_page`, `ticket_staff:issue_page`, `ticket_staff:check_in_page`, and `ticket_staff:detail`.
- `GET /staff/tickets/manage/` supports `activity_id`, `batch_reference`, `serial_number`, and `state` filters and renders counts by state.
- `GET/POST /staff/tickets/issue-page/` accepts activity, quantity, batch reference, and serial prefix, then renders one-time secret/QR results with `no-store` headers.
- `GET/POST /staff/tickets/check-in-page/` accepts a secret in a POST body and renders accepted/duplicate/invalid feedback without putting the secret in a URL.
- `GET /staff/tickets/<id>/detail/` shows activity, batch, serial, lifecycle timestamps, and links for permitted actions; it never displays `secret_digest`.
- `POST /staff/tickets/<id>/action/` is admin-only and accepts `action=void` or `action=revoke`, delegating to the existing services.

- [ ] **Step 1: Write failing HTTP/page tests.**

```python
self.client.force_login(self.staff)
response = self.client.get(reverse("ticket_staff:list_page"), {"state": "issued"})
self.assertEqual(response.status_code, 200)
self.assertContains(response, "票据管理")
self.assertContains(response, "issued")
self.assertNotContains(response, issued.secret)
self.assertNotContains(response, issued.ticket.secret_digest)
```

Add tests for staff-only access, batch issue result count and QR output, check-in POST feedback, detail secret redaction, admin-only void/revoke, and participant denial.

- [ ] **Step 2: Run the focused page tests and verify RED.**

```bash
uv run python manage.py test tickets.tests.TicketStaffHttpTests
```

Expected: the named page URLs do not resolve and the existing placeholder templates do not contain the required controls.

- [ ] **Step 3: Implement page views and URLs.**

Use the existing `staff_required`/`admin_required` decorators. Query list rows with `select_related("activity")`, apply only allowlisted filters, compute state counts from the filtered queryset, and render the four existing templates. Use the batch service for issue POSTs. Generate QR PNGs in memory with `qrcode` and base64 data URIs; never create media files or place the secret in a request URL. Add `Cache-Control: no-store` and `Pragma: no-cache` to issue result responses.

- [ ] **Step 4: Replace placeholders with operator controls.**

The list page contains filter controls, state counts, issue/check-in links, and row detail links. The issue page contains activity/quantity/batch/serial inputs and one-time QR cards. The check-in page contains a POST form and explicit invalid/accepted/duplicate messages. The detail page contains lifecycle metadata and admin action forms with CSRF tokens.

- [ ] **Step 5: Run focused page tests and system checks.**

```bash
uv run python manage.py test tickets.tests.TicketStaffHttpTests
uv run python manage.py check
```

- [ ] **Step 6: Commit.**

```bash
git add tickets/views.py tickets/staff_urls.py templates/staff_panel/ticket_*.html tickets/tests.py
git commit -m "feat: add ticket operator pages"
```

### Task 4: Close the ticket issue-to-vote verification slice

**Files:**
- Modify: `tickets/tests.py`
- Modify: `docs/production-readiness.md`
- Test: existing ticket-backed voting tests and Playwright smoke if the local service is available

**Interfaces:**
- The regression path is staff issue → public scan/redeem → check-in → ticket-backed vote eligibility.
- A redeemed `issued` ticket must not be described as vote-eligible and must be rejected by ticket-backed voting until check-in.
- A `checked_in` ticket must receive the existing short-lived session and be accepted by the existing ticket-backed voting service.

- [ ] **Step 1: Add the end-to-end authority test before changing any additional code.**

Exercise the real Django client through the page/API boundaries, assert the pre-check-in vote rejection, call the staff check-in page/API, then assert the same ticket session can pass the existing ticket-backed vote boundary.

- [ ] **Step 2: Run the focused regression and verify the expected pre-check-in failure is asserted.**

```bash
uv run python manage.py test tickets.tests voting.tests
```

- [ ] **Step 3: Run the complete local gates.**

```bash
uv run python manage.py makemigrations --check --dry-run
uv run python manage.py test
npm run check:pyright
npm run check:pyright:entry-access
npm run check:client
npm run test:client
```

- [ ] **Step 4: Update the readiness record with actual results.**

Replace the old “operator surface incomplete” statement with the exact tested page/API coverage. Do not mark full production readiness until PostgreSQL, Playwright credential flow, and deployment rehearsal gates have also passed.

- [ ] **Step 5: Commit.**

```bash
git add tickets/tests.py docs/production-readiness.md
git commit -m "test: close ticket issue to vote rehearsal"
```

## Review Checkpoints

After Task 2, inspect that batch issuance cannot partially commit and that no raw secret enters persistent storage. After Task 3, inspect every template response for secret/digest leakage and confirm all mutation paths still delegate to ticket services. Before integration, run the full authority and type gates and review the final diff for URL/API compatibility.
