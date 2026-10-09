# Changelog

## 2026-10-09 (later)

### The judge entry has a credential, so a public activity code is no longer a seat

`/e/<public_code>/judge/` was reachable by anyone, the public activity page linked to it,
and `judge_claim` asked only for the activity. Opening that URL claimed a real `JudgeSeat`
and minted a real `JudgeSession`, and the score that followed was a `DIRECT_JUDGE` fact with
the right seat, the right panel, the right context version, the right receipt and the right
audit entry — so no downstream guard could tell it apart from a teacher's, because it was
not different. The authority behind the door was never the problem; the door was.

The shared QR now carries a capability in its **fragment**
(`/e/<code>/judge/#AF1.J.<code>.<version>.<signature>`), which the browser never sends: it
stays out of access logs, out of `Referer`, and out of the HTML the terminal renders. The
terminal reads it, clears it from the address bar, and presents it once when it claims a
seat. The capability is an HMAC keyed on `QR_SIGNING_KEY` over
`judge-entry:<code>:<version>`, domain-separated from the ticket credential so neither can
be replayed as the other.

- `singer_contest.judge_entry` issues and verifies it; the version is read from the row, not
  trusted from the token, so a reissue invalidates every previously printed code at once.
- `judge_claim` resolves the activity **through** the capability and refuses a code that does
  not resolve exactly as it refuses a missing activity. A capability that resolves while the
  entry is closed says so (`JUDGE_ENTRY_CLOSED`) — only a holder of a valid code reaches
  that line, and "you are early" is a different instruction from "scan again".
- A **held seat needs no capability**: the session is the credential by then, so a refresh, a
  locked screen or a reconnect still works without re-scanning (§12.3's promise). The
  reuse branch is checked *before* the capability for exactly that reason.
- The public activity page no longer links to the judge entry. That link was how anyone
  found the door; with the capability in place it would only be a link to a door with no key.
- `judge_entry_open` now covers the live night, not just a rehearsal: staff open the entry,
  the panel scans in, staff close it, and a photographed QR claims nothing afterwards.
  Sessions already claimed are untouched. The workspace shows the current version and gains
  **重发评委二维码**, which bumps `Activity.judge_entry_version` — the right tool for a leaked
  code, where closing the entry would also turn away the teacher who is walking up.
- The execution package's judge QR carries the same fragment, so the ZIP a print shop
  receives is no longer a sheet full of keys to a door anyone can open.
- Claim gets a rate limit of its own; it had none, so a script could have walked the seat
  list to `JUDGE_TERMINALS_FULL` and locked the real panel out.

### Upload compensation now spans the whole unit of work

The previous batch compensated the storage write when the remainder of `_store_file` failed,
which left two holes the review named:

- **The row never existed.** `FileField.pre_save` commits the bytes *before* the INSERT runs,
  and `objects.create()` raises without returning the object, so the bookkeeping never
  learned the file's name. `_store_file` now builds the instance explicitly and asks
  Django's own `_committed` marker — set by the commit that happens before the INSERT —
  whether there is anything to remove.
- **A later statement in the same transaction failed.** `store_questionnaire_file` and its
  group counterpart write an audit row after the upload; that insert failing rolled the file
  row back and left the bytes. The compensation is now a context manager that the callers
  wrap their whole body in, and `_store_file` takes the list it records into, as a required
  argument — a caller that forgot to open the block would leave orphans silently, and there
  is no default that would do the right thing.

Both holes have a regression test that fails against the previous code.

## 2026-10-09

### A rotated ticket credential is now dead the moment the rotation commits

`rotate_ticket_credential` bumps `credential_version` and revokes the browser sessions the
printed code already produced, so that a leaked code can be killed on the spot. That held
against every request that *started* after the rotation, and not against one that had
already resolved the code: the resolution happens before the row lock can be taken, and the
code after the lock re-read the row and checked only its `state`. A check-in would therefore
succeed with a code the operator had just invalidated, and — worse — a redemption would mint
a fresh `TicketAccessSession` immediately after the rotation revoked the old ones, so
resetting a leaked code could visibly create a working session from it.

Both `check_in_ticket_outcome` and `redeem_ticket` now re-resolve the credential against the
locked row (`tickets.services._credential_authorizes_ticket`), so the final authorization
decision depends on the version the row holds now. `state` was already re-checked by each
caller's own guard, which is why revoke and void never had this problem.

Two `TransactionTestCase` race tests pin the interleaving deterministically by holding the
resolution step open while the rotation commits on another connection — both fail against
the previous code and pass against this one. They are `postgresql`-marked, because SQLite
cannot express the race.

### A failed upload no longer leaves its bytes behind

`files.services._store_file` writes to storage before the row that references it can commit,
and a rollback does not take the bytes back. Anything that failed between the write and the
commit — including a failure raised by the caller's own transaction — left a file no row
points at: invisible to the application, still occupying the media volume, and still counted
by the low-water check that refuses uploads when free space runs out. The write now
compensates by deleting what it just wrote, while superseded files keep using
`transaction.on_commit`, which is the opposite direction on purpose. The
`ARTFLOW_UPLOAD_MAX_VERSIONS` validity check also moved to the precondition block, where it
belongs — it used to run *after* the write, so a deployment with an invalid value orphaned
one file per attempt.

## 2026-10-08 (later)

### Peripheral authority closure — the staff path, the archive sheet, the rehearsal QR

Four places where the main authority was already correct and something further out
described it differently.

- **The archive refused nothing when a singer contest had no frozen ruleset.** The previous
  batch made archiving require a closeable result line, and exempted activities whose
  closure reported `no_current_frozen_ruleset` — which exempts a singer contest that never
  froze one. A singer contest's formal outcome *is* a confirmed stage result, so having no
  frozen ruleset is a reason to refuse, not a reason to skip. The exemption is now decided
  by `activity_type`: a farewell show or a general activity has no ruleset-driven result
  line and is unaffected; a singer contest always has one. Locked rounds and complete
  scores alone used to be enough to reach `ARCHIVED` with a package calling itself the
  authoritative record.
- **`stage_results.xlsx` scanned the activity's whole `StageResult` history.** When a
  ruleset drops a checkpoint — a `semifinal` in v2 — the old confirmed row for it survives
  in the database, and the sheet printed it beside the stage keys that are current. The
  rows now come from `build_result_closure`, which already answers "which stage keys does
  the current ruleset declare, and which result version is current for each", instead of
  that question being re-derived by hand in a second place.
- **The staff cover-image upload bypassed the public-media safety chain.** `PublicPostForm`
  is a plain `forms.Form` with no cover field, and `post_create`/`post_edit` assigned
  `request.FILES["cover_image"]` straight onto the model. So the daily staff path skipped
  `forms.ImageField` — which is what rejects a file that is not really an image — and
  skipped `sanitize_upload`, which bakes EXIF orientation into the pixels and writes no
  metadata back. Phone photos carried GPS, device and timestamp metadata onto the public
  page through the ordinary path while the admin path stripped them. The field is declared
  on the form, both views pass `request.FILES`, and both read the sanitized value.
- **The execution package embedded rehearsal QR codes with no warning.** The QR centre
  warns on screen when the code was built from a non-production host (GOAL §11.5), but this
  ZIP carries four ready-to-print PNGs and said nothing — the warning covered the screen
  the operator looked at, not the file that leaves the building. A LAN rehearsal is a
  legitimate use, so the codes are still produced; the package now includes
  `QR-NOT-FOR-PRINT.txt` naming the host it was built from. The host rule itself moved to
  `public_portal.services.qr_print_host_warning` so the two callers cannot drift.

## 2026-10-08

### Archive authority closure — the record has to describe what the system confirmed

The live contest chain had already converged on "a candidate is not a result". Archive,
export and retention still described the system as it was a few revisions earlier, which
is a different kind of failure: the contest computes correctly, and the record that
outlives it does not.

- `exports.services.archive_activity` refuses to archive while the result line is not
  closed, and it asks the question the public release path already asks
  (`build_result_closure(...).closeable`) rather than a local "is there a CONFIRMED row"
  test — which would miss a stale candidate, an old ruleset version, a missing checkpoint,
  an unconfirmed upstream and a fingerprint mismatch. Activities with no current frozen
  ruleset (a farewell show) are unaffected, and the exception is stated in the code rather
  than left implicit.
- `voting.services.valid_vote_count` is now the single `Count` annotation for the §9.3
  valid-ballot population, used by the staff vote detail, the staff vote export and the
  archive's `vote_results.xlsx`. The two exports had annotated a raw `Count("records")`,
  so a ticket revoked after it voted reappeared in the spreadsheet and in the archive
  while the result itself correctly excluded it. Taking the relation name rather than the
  filter prefix keeps the two paths from being written twice.
- The permanent archive no longer carries `staff_notes.xlsx`. GOAL §19.2 forbids keeping a
  临时 Staff note because of archiving, and `prune_retained_state` deletes the rows on the
  retention schedule — so the database copy was pruned on time and the copy inside the ZIP
  was not, which is a retention shadow copy rather than retention. The pre-event execution
  package still carries them; that is where a temporary operational note belongs.
- The archive's incident sheet and the staff incident export share one row builder and one
  column set. The archive had kept the thinner older one, losing exactly the §16 evidence
  a review wants: the round, the authority state at the time, the problem, the action
  taken, and whether a post-event review was needed.
- `purge_retained_pii` measures the retention window from `locked_at` — the archive
  instant — instead of `updated_at`. `archive_activity` saves with an explicit field list
  that does not include `updated_at`, so an activity dormant for a year and archived this
  morning looked a year old the moment it was archived and the first sweep anonymised it.
  An archived row with no timestamp is reported rather than swept on a guess.
- `backup_artflow.file_fields()` discovers every `FileField`/`ImageField` from the model
  registry instead of listing three. Cover images, media derivatives and export files that
  the database references but the disk lost produced a *passing* restore verification: the
  media digest proves the tree matches itself, not that it ever held what the rows name.
- The archive gains `stage_results.xlsx`, naming the confirmed result version, who
  confirmed it and what it decided. `score_results.xlsx` is a per-round average, which was
  the whole picture only while a `ScoreSummary` *was* the result.

## 2026-10-05

### Mobile layout — a scroll-free phone contract

Staff pages were desktop layouts with a hamburger menu bolted on. A phone width made an
`<h1>` next to a filter form collapse into a vertical column of single characters, and a
`<select>` whose width follows its longest option pushed whole pages sideways.

- `playwright.config.ts` — seven phone widths (320 / 360 / 375 / 390 / 393 / 412 / 430)
  are now first-class projects. The iPhone projects run WebKit, because that is what iOS
  Safari and WeChat on iOS actually are; the Android ones run Chromium. Layout is decided
  by the CSS viewport width, so seven widths span the range without simulating every
  handset.
- `tests/e2e/mobile-layout.spec.ts` + `prepare_layout_e2e` — the audit is a real spec
  against a disposable fixture, in the same shape as the other five browser flows, so it
  runs in CI and each page is individually runnable from the editor. The assertion is
  about the document, not about every element: a wide data table inside `overflow-x-auto`
  is meant to scroll in its own box (this is what Django's own admin does for its
  changelists) — what must never happen is the page itself scrolling sideways.
- `static/css/src.css` — one base rule, `input, select, textarea { min-width: 0 }`. A form
  control defaults to `min-width: auto`, which for a `<select>` is the width of its
  longest option; that alone was blowing single-column mobile grid tracks out of the
  viewport on several pages.
- Page headers and filter rows that measured as broken were made to stack on small
  screens.

### Mobile touch targets — a measured floor, not a feeling

A page that fits a phone can still be unusable on one: staff tap the vote switch,
check-in, judge connection and incident notes one-handed, in a dark room, in a hurry.
`mobile-touch.spec.ts` measures every control on the same pages the layout audit walks.

- **The gate is 24x24 CSS px, the WCAG 2.2 AA minimum (2.5.8), not 44x44.** Measured
  first: at 44px, 489 of 529 standalone controls miss the bar — that is not a gate, it is
  a rewrite of nearly every control in the app. At 24px the number was 172, concentrated
  in a handful of shared patterns, which is a gate that can be held. The threshold stays
  overridable (`PLAYWRIGHT_TOUCH_MIN_PX`) so the stricter bar can be probed as that debt
  is paid.
- **Inline links are excluded, per the rule's own exception** (2.5.8 exempts a target
  bounded by the line-height of its sentence). The probe reads the computed `display`:
  a standalone action link is blockified by its container, one inside a sentence is not.
  Without this the audit reported the footer and page-header prose links as failures.
- `tests/e2e/layout-targets.ts` — the page list moved to one module so the layout and
  touch specs cannot drift apart; `mobile-layout.spec.ts` had already grown its own copy.
- `static/css/src.css` — two base rules carry most of it: every `input`/`select`/`button`
  gets a 24px `min-height` (a control is otherwise only as tall as its text — 16px for a
  `text-xs` button, 20px for a bare Django widget), and checkbox/radio controls are sized
  directly, which lifts the wrapping label with them. The `staff-touch-target` component
  is renamed `touch-target`: it is applied to public pages now, and padding is part of the
  target, so the box grows around the label.
- The desktop `chromium` project ignores both mobile specs; the touch audit was otherwise
  running a second time at desktop widths.

### Browser specs — the type-check gap that was hiding in plain sight

Playwright only *transpiles* the specs in `tests/e2e/`; it never type-checks them. No
tsconfig included them either — `tsconfig.client.json` covers `frontend/**` only — so the
browser flows were the one part of the tree checked by nothing, the same shape of gap the
type-check baseline just closed for the Python apps.

- `tsconfig.e2e.json` + `npm run check:e2e` — `noEmit`, strict, and directory-level over
  `tests/e2e/**` and `playwright.config.ts`, so a new spec is covered the day it lands
  rather than the day someone remembers to add it. Wired into the Linux quality job beside
  `check:css` and `check:client`.
- `@types/node` becomes a devDependency: the specs read `process.env` and `node:fs`.
- Turning it on surfaced eight real errors in specs written before the gate existed, all
  fixed rather than suppressed: two implicitly-`any` `page` parameters and a
  module-scope narrowing that did not survive into a nested function
  (`human-acceptance.spec.ts`), and six unchecked array indexes
  (`judge-shared-entry-flow.spec.ts`).

### Toolchain — the type-check baseline covers the whole project

`pyrightconfig.json` was a hand-written list of twenty file names that stopped growing
several apps ago: it covered 22 of 181 production modules, so ten apps were checked by
nothing. `[tool.mypy] files` and `[tool.ruff] src` were each missing two apps.

- The baselines are directory-level now. Widening them surfaced 194 pyright diagnostics
  and 20 mypy ones, all fixed rather than suppressed — most were Django's runtime-created
  attributes, declared where the project already declares them.
- `pyrightconfig.entry-access.json` is deleted: once the baseline covers every app, that
  scoped config checked a strict subset of it. GOAL §21.1 asks for exactly this.
- `CLAUDE.md` / `AGENTS.md` — a configuration sweep after each change round is now part of
  the workflow. A whitelist keeps passing while the tree grows past it.
- `.env` templates document the delivery backend, the five upload limits, the PII
  retention window and the live-state cache TTL, with their real defaults. `.dockerignore`
  gains `node_modules/` and `backups/`; dependabot gains the npm ecosystem.

### Media downloads — a load rehearsal, and the capacity ceiling it found

`controlled_media` authorizes a private path and then streams the bytes through the
Gunicorn worker that is handling the request; there is no separate file service and no
`X-Accel-Redirect`. The production doc has always required a load rehearsal before the
first live event — this makes it repeatable instead of a promise.

- `scripts/media_download_load_rehearsal.mjs` drives N slow readers, because client
  back-pressure is what holds a worker open (a loopback client drains the file and lets
  go). It probes `/livez/` on an independent connection, so "the app stopped answering"
  becomes a number, and it re-checks *while the workers are saturated* that an
  unauthenticated request still never receives bytes — a timeout is the starvation being
  measured, not a bypass.
- `prepare_media_download_rehearsal` / `cleanup_media_download_rehearsal` create and
  remove exactly one TEST activity, registration and 100 MiB submission file, the largest
  payload a formal activity accepts today.
- Result on the shipped three-worker pool: two slow downloads are invisible, the third
  stalls the application (probe p50 ≈ 4.9 s, half of the probes timing out). Adding
  workers only moves the threshold, so the evidence points at the delivery seam's Phase B
  — getting the bytes off the worker — rather than at pool size. Numbers and boundaries
  are recorded in `docs/production-readiness.md`.

### Phone layout — the raised-font half of the contract, and why only CI could see it

The scroll-free phone contract had been red on `main` for five commits: eleven layout
tests failed in CI while the same commit passed locally. Two causes, both reachable only
once the reader raises the font size to the gate's 1.75×.

- `static/css/src.css` — `body { overflow-wrap: anywhere }`. An activity title's word, a
  ruleset code, a template name: a long token has nowhere to break, and what it actually
  blows out is the min-content of a single-column grid track — a track never goes below
  its items' min-content. `break-word` does not help, because it only breaks while
  painting; only `anywhere` also lowers min-content, which is what lets the track shrink.
- `static/css/src.css` — the "unsized form control gets `width: 100%`" rule asked whether
  the control had *no class at all*, but `text-xs border …` styles a control without
  sizing it, so the export center's note fields kept the user agent's 20-character default
  and stretched their card on every phone width. The test is now whether a width was set,
  not whether a class exists; width utilities sit in the later cascade layer, so `w-full`,
  `w-20` and `flex-1` keep their own width and only genuinely unsized controls are capped.
- The local/CI split was engine, not code: the iPhone projects run WebKit, and Linux
  WebKit resolves the system sans stack to a fallback roughly a fifth wider than Windows',
  which is what pushed each marginal case over. Reproducing it needs that engine *and* the
  same data state — the note fields only render once an activity is locked, which the local
  layout fixture never did.

## 2026-10-04

### Judge entry — one shared QR, and the participant gets told when group material changes

- `staff_panel` — the per-seat judge QR entry is retired. Judges scan one shared QR and
  claim a free seat by arrival order; the staff view, route, template block and the
  per-seat grant context it fed are gone. The short-lived grant mechanism itself stays:
  it is the documented legacy fallback and the judge browser fixtures still use it.
- `files` / `docs/realtime-collaboration.md` — the participant group-material page joins
  the `/ws/group/<pk>/materials/` room the backend already mounted and published to, so
  members see who else is on the page and get a refresh banner when another member or a
  staff member changes the material. Presence stays advisory and never becomes an edit
  lock.

### GOAL gap closure — incident detail, audience provenance, PDF handcard, public derivatives

Four capabilities `GOAL.md` describes were not implemented; each is now covered by tests.

- `incidents` — an incident records the affected round, the authority state it happened
  under, and whether it needs a post-event review. The state defaults to an explicit
  "unrecorded" so an incident filed afterwards never invents it.
- `singer_contest` — a manually verified audience score records where its numbers came
  from (external form / paper tally / other) plus a short note. The API keys are optional
  and only restamp provenance when a source is supplied, so correcting a number cannot
  erase what was recorded.
- `exports` — the stage result handcard is downloadable as a PDF, rendered from the same
  `stage_decisions_by_blocks()` structure the staff page shows.
- `files` / `common` / `public_portal` — the private original is now separated from the
  public derivative. An image upload gets a metadata-free re-encode (EXIF orientation
  baked into the pixels, no metadata written back); a caller whose only claim is
  `is_public` is served that derivative while staff and the owner keep the original.
  Staff-uploaded gallery photos, which have no private original, are sanitized in place.

### Test infrastructure and runtime hot paths

- make polling read-only and take the hot paths off the request thread
- add realtime collaboration phases
- complete group chorus workflow
- preserve rapid score lock checks
- close runtime readiness and judge polling gaps
- restore installation state after flush
- expose doctor test diagnostics
- release worker-thread connections in concurrency tests
- isolate migration test state
- type migration teardown cleanup
- satisfy the mypy gate for the reportlab and derivative work
- fix realtime type gate
- satisfy group chorus type checks
- format questionnaire model
- refresh compiled css asset

## 2026-10-03

Live venue orchestration closed; the browser acceptance suite stabilised; migration
test isolation finished across the historical suite.

- add live QR and mobile现场 flows
- close live venue orchestration
- complete live venue orchestration
- stabilize live browser acceptance
- close final live acceptance regressions
- align judge client acceptance fixture
- remove flaky judge browser extension
- stabilize shared judge acceptance
- fix judge hold browser gate
- close advice acceptance gaps
- preserve activity migration compatibility
- isolate all historical migration tests
- isolate migration rollback teardown
- restore migration test state
- fix PostgreSQL marker typing
- type database test configuration
- preserve database setting field types
- isolate sqlite xdist test databases
- streamline CI test gates
- apply live entry formatting
- format feature modules
- refresh compiled tailwind asset

## 2026-10-02

- isolate browser acceptance fixture setup
- close CI quality and bootstrap gates
- close batch three integration contracts

## 2026-09-30

Human acceptance batch 3 closed; the compose contracts aligned.

- close human acceptance batch 3
- fix human acceptance CI runtime
- prepare compose human acceptance state
- satisfy mypy quality gate
- align roster and questionnaire contracts
- align compose test contracts

## 2026-09-29

Human acceptance batches 1 and 2 closed; the questionnaire rehearsal blockers
cleared; the Windows CI matrix corrected.

- close staff human acceptance batch 1
- close human acceptance batch 2
- close post-merge review finding
- complete questionnaire rehearsal blockers
- align questionnaire quality baseline
- close questionnaire mypy gate
- fix questionnaire CI gates
- fix admin activity creation form
- honor windows python matrix in ci
- keep windows uv commands on matrix python
- allow windows ci suite to finish
- fix linux ci timeout
- fix compose restore network resolution

## 2026-09-28

The ruleset-driven questionnaire landed; auth and event-day UX hardened.

- Ruleset-driven questionnaire
- complete private rehearsal hardening
- close account operations gates
- add role access-key account flows
- harden auth and event UX
- harden UX safety and mobile rehearsal
- fix auth browser smoke contract
- align judge browser contract
- tune shared registration throttle
- fix event runtime CI compatibility
- fix event runtime network boundary
- fix CI result type gate
- close formatter CI gate

## 2026-09-27

Production release readiness closed: backup durability, deployment gates and the
singer final business boundary.

- harden production release readiness
- harden production deployment gates
- harden production backup durability
- close production operations gates
- formalize the singer final business boundary
- fix CI media and release provenance
- harden CI retry and redirects
- clear mypy quality gate errors
- fix activity clone lifecycle
- make the upload throttle regression test backend-stable

## 2026-09-24

Commercial event runtime and first-run provisioning.

- add commercial first-run setup
- add commercial event runtime
- add commercial first admin provisioning
- fix first-run mypy typing
- refresh commercial setup css

## 2026-09-23

- prepare commercial brand neutrality
- close compose branding propagation
- close m2-d2 release gate

## 2026-09-21

M2-D2 result release authority closed; M2-D1 gate closed; pre-M2-D2 cleanup.

- complete m2-d2 result release authority
- close m2-d1 gate
- pre-m2-d2 code cleanup
- fix result correction rehearsal
- restore postgres acceptance gates
- stabilize postgres restore gate
- format restore gate contract
- satisfy cleanup type gates
- fix cleanup lint gate

## 2026-09-11

- integrate m2-d1 result authority closure
- record m2-d1 docker rehearsal

## 2026-09-10

- require inline agent execution

## 2026-09-08

M2-B ticket entitlement and the whole M2-C judge authority chain — panel policy,
staff judge control, the judge client — plus the malicious rehearsal matrix.

- integrate M2-B ticket entitlement
- integrate m2-c1 actual panel policy
- integrate m2-c2 staff judge control
- integrate m2-c3 judge client close
- integrate m2-c judge authority
- integrate M2-C judge authority plan
- integrate m2-c gate
- integrate m2-c malicious rehearsal gate
- integrate m2-c malicious rehearsal matrix
- record m2-c malicious rehearsal
- close m2-c authority and browser gates
- integrate attack rehearsal fixes
- harden security abuse boundaries
- integrate m2-b ticket operator surface
- sync production requirement export

## 2026-09-07

M2-A entry access foundation, the M2 progressive toolchain gates, and the M1
authority baseline.

- integrate M1 authority baseline
- harden authority and runtime baseline
- close M1 residual contracts
- record M1 production rehearsal
- add M2-A entry access foundation
- finalize m2-a proxy boundary
- add progressive M2 toolchain gates
- harden security boundaries and type gates
- add typed rapid score client boundary
- add client tooling micro-refactor
- close CI and service authority gaps
- publish school readiness goal baseline
- record agent execution and proxy rules

## 2026-09-04

GOAL v4 baseline established; M1 identity, state and core-raw authority closed.

- establish GOAL v4 baseline
- close m1-i execution baseline
- close core raw authority baseline
- close M1 state and identity authority
- fix postgres capability fixture
- extend Windows CI timeout

## 2026-09-01

### Batch A — M1-CORE-CLOSE (authority closure)

Sealed the remaining ORM authority leaks so an activity's ruleset and stage result only
transition through a formal service, and made the binding migrations safe on historical dirty
data. No new contest capability — this closes the reviewer's "6 things".

- `ruleset` / `singer_contest` — the public `_allow_freeze` / `_bypass_confirmed` kwargs were
  removed; a FROZEN/current `RulesetVersion` and a CONFIRMED `StageResult` can no longer be
  manufactured through the ORM, only through `freeze_ruleset_version` / `confirm_stage_result`
  (and unlock via `unlock_stage_result`), guarded by `common.authority` write scopes.
- `StageDecision` / `CompositeResult` — creating a child on a CONFIRMED parent is blocked;
  `ManualDecision` `QuerySet` mutations (update/delete/bulk_create/bulk_update) are sealed
  behind the formal `set_manual_decision` service.
- `singer_contest` — formal publication is only `recompute_activity_result()`, which always
  reads the round mapping from the frozen version's binding (the `round_keys` override was
  removed); a CONFIRMED `StageResult` is immutable once confirmed.
- The binding migrations renumber duplicate `RulesetVersion`/`StageResult` version counters and
  demote a legacy CONFIRMED row missing its confirming actor, so they apply cleanly rather than
  failing on historical dirty data.

### M1-R9-Final — formal-authority closure

Closed the 6-item reviewer closure on the formal authority path: `RulesetVersion → FROZEN/current`
and `StageResult → CONFIRMED` are sealed behind their services; `StageResult` reuses only its
latest same-fingerprint result (any historical row is minted as a higher version); bound vote/source
scale is authoritative over a node-declared scale; a SELECT `auto_break` tie source must equal its
source RANK's; the 校十佳 historical fallback is within-scope-merged and deterministic; and the
version-unique / `ContestRuleset UNIQUE(activity)` migrations renumber-first and dedupe.

### CI quality gate — mypy / ruff baseline

### CI quality gate — mypy / ruff baseline

Brought the repo-wide lint-and-type gates to green (the `Linux SQLite quality gate` job
was red on a pre-existing mypy debt plus unformatted code):

- `mypy` — resolved all 309 baseline errors to zero by annotating production helpers
  (`accounts/services.py` stdlib `datetime`/`utc` imports, `ruleset` compiler/resolver/
  schema, `singer_contest` services, `staff_panel`, `common.lifecycle`) and adding scoped
  `# type: ignore[...]` markers on the legacy black-box test suites. `ruleset` is now a
  declared mypy-checked app, and the characterization suites sit in a documented gradual
  override (mirrored in `scripts/tests/test_quality_configuration.py`).
- `ruff` — fixed an import-order issue and re-wrapped out-of-format source files, and
  excluded `docs/` from the format gate: planning/advice docs are prose with illustrative
  snippets, not source code, so formatting them only adds churn (mirrors the existing
  migrations/media/staticfiles excludes).

### M1-R9 — Authoritative Result Snapshot Closure

Closed the remaining integrity gaps between the resolver engine and production so a
result board reflects exactly what the authoritative ruleset produced.

- `ruleset` — added `vote_keys` / `group_keys` binding fields on `ContestRuleset` and a
  minimal `ruleset_bind` staff editor, so `recompute_activity_result` can auto-source
  audience votes and group membership from the database instead of needing hand-injected
  kwargs.  Added `ManualDecision` (singer_contest) so `MANUAL_SELECT` picks persist and
  re-read under a formal service path.
- `singer_contest` — `recompute_activity_result` now sources `vote_scores`, `group_of`, and
  `manual` from the DB; `run_ruleset(preview=True)` is an isolated in-memory comparison that
  never persists a `StageResult`, so a superseded frozen version cannot pollute the board.
- `staff_panel` — a result-board fix kept tests green under the new per-stage publication
  number.

## 2026-08-31

### M1-R5 / M1-R6 / M1-R7 — Authority closure, stage finality, resolver truthfulness

- `RulesetVersion` closed three authority gaps: a canonical binding hash, exact version
  identity, and a single-activity constraint.  `confirm_stage_result` finally locks a result
  only when it is grounded on the current FROZEN authority; unlock (`unlock_stage_result`)
  reverts a CONFIRMED result with an audited admin verifier.
- `StageResult`/`StageDecision`/`CompositeResult` became immutable once CONFIRMED; a result's
  `result_version` is pinned at publication time so two concurrent recomputes cannot mint the
  same number.
- Checkpoint decisions now carry their own stage output; the honest `golden_xiaofeng` was
  re-labelled as a control-flow demo rather than a historical Golden.

## 2026-08-29

### M1-B → M1-J — Contest domain, resolver, golden simulations, operations

- `singer_contest` / `ruleset` — a generic contest-fact model decoupled `Performance` from
  `SingerRegistration`, plus a versioned typed ruleset schema (`ContestRuleset` /
  `RulesetVersion`), a compiler/validator that rejects a ruleset before freeze, and a
  `resolve_to_checkpoint` scoped resolve.
- Added the deterministic stage resolver engine (`M1-E`), the 2025 院十佳 golden simulation
  (`M1-F`), the group-scoped `SELECT`/`by` + 2025 校十佳屏峰 golden (`M1-G`), and the
  backstage rapid-score-entry + result board (`M1-H`).
- `M1-I` — a staff ruleset template library, editor (create/validate/preview/freeze), and
  "clone last year + instantiate template" flow.
- `M1-J` — strict score-workbook snapshot fingerprint with all-or-nothing reject, an oversized
  video direct-upload ban in production UI, and rehearsal report templates.

## 2026-08-28

### M0 hardening + M1-A

Hardened the system invariants that the contest domain builds on, then shipped M1-A:

- Activity-first authority and transaction lock hierarchy (Activity → child → dependent), with
  phase and lifecycle enforced as authorization policy.
- Explicit, literal activity phase-transition graph; ARCHIVED readonly and re-openable only by
  an audited admin operation.
- TEST/FORMAL strict isolation; runtime rows carry a lifecycle marker; test cleanup refuses a
  cascade that would touch formal data.
- Immutable round snapshots with a prepared-round workflow; `RoundEntry` snapshot pairs; round
  preparation guard rails (base-manager and bulk-mutation guards).
- Activity-scoped personal-data exports with a uniform EXPORT audit; production user/role
  administration via an audited domain service; complete material-review and
  participant-editing loops; formal execution/archive packages.

## 2026-08-27

### Production correctness hardening + competition domain hardening

- Added the PostgreSQL/Compose acceptance contract, expose-data scope rules, and a backup/
  restore drill; closed the production business invariants that a live run depends on.
- Added the competition-domain hardening plans and specs (round snapshots, vote state service,
  advancement finality, registration uniqueness).

## 2026-08-18

### Engineering baseline

- Documented lockfile-based development setup, SQLite and PostgreSQL runtime paths, container data volumes, diagnostics, health checks, and safe demo-data reset behavior.
- Recorded local and CI quality gates, troubleshooting guidance, and source-control and secret-handling expectations.
- Added documentation validation for stale setup instructions, unsafe sample credentials, aggregate implementation counts, and unresolved repository-relative Markdown links.
