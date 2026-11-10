# M15.3 Attendance / Check-in Capability Design

- Date: 2026-11-10
- Status: accepted for implementation
- Scope: M15.3 only
- Roadmap: [M15.3](../roadmap.md)

## Intent

M15.2 gives Ops durable task ownership. It does not record who actually arrived
at the event. M15.3 adds an independent, optional `attendance` capability that
records a check-in fact for three subject types — participants, tickets, and
staff/volunteers — at named check-in points inside an activity.

Attendance is observational. It never changes registration, ticket, competition,
voting, publishing, archive, task, or activity-lifecycle authority, and no other
capability gates an action on it.

## Scope

In scope:

- activity-level check-in points with a key, display name, allowed subject
  types, and an active flag;
- an activity-level staff/volunteer roster;
- check-in and undo facts for `participant`, `ticket`, and `staff` subjects;
- mode-partitioned facts and a current projection;
- a running `checkin` execution session as the authority for when check-in is
  open;
- protected read surfaces for Ops and Live;
- outbox invalidation through the existing realtime core.

Out of scope for this slice:

- check-out, duration, late/absent/excused states, or attendance-based scoring;
- participant self-check-in, public attendance pages, or camera/QR scanning;
- changing ticket state or consuming `ticket.redeem`;
- cross-activity attendance, shifts, rooms, or resource management;
- offline reconciliation or bulk import;
- requiring a real activity rehearsal for acceptance.

## Authority boundary

1. Attendance owns only its own point, staff, fact, and current rows.
2. The expected participant set is the activity's approved registrations; the
   expected ticket set is the activity's tickets; the expected staff set is the
   attendance staff roster. These are read-only references, not copied facts.
3. A ticket check-in is independent of `ticketing.ticket.redeem`. The same
   ticket may be checked in at the door and later redeemed for voting; neither
   action changes the other.
4. A check-in command requires a running execution session with scope `checkin`.
   The session's mode is the fact's mode. Formal and test attendance never mix.
5. Every write uses the single write path: receipt, audit, fact, and outbox in
   one transaction. Undo is a new fact; history is never deleted.
6. The raw ticket credential is resolved to a ticket id in the API layer. It
   never enters the command payload hash, receipt, audit, outbox, or logs.

## Capability contract

| Field | Value |
| --- | --- |
| identity | `attendance` |
| version | `1` |
| dependencies | none |
| conflicts | none |
| surfaces | `studio`, `ops`, `live` |
| commands | `attendance.point.create`, `attendance.point.update`, `attendance.staff.add`, `attendance.staff.update`, `attendance.checkin`, `attendance.undo` |
| queries | `attendance.list`, `attendance.staff.list` |
| events | `AttendancePointChanged`, `AttendanceStaffChanged`, `AttendanceCheckedIn`, `AttendanceUndone` |
| permissions | `attendance.manage` |
| execution scopes | `checkin` |
| command scopes | `attendance.checkin → checkin`, `attendance.undo → checkin` |

The capability is optional. A pack may enable it; the Guided catalog adds an
attendance question (default off) to the singer and stage-show packs.

## Definition and release semantics

The definition payload is schema version 1 and carries no frozen roster or point
list:

```ts
type AttendanceDefinition = {
  schemaVersion: 1;
};
```

Points and the staff roster are activity-level operational data, managed through
audited commands. The release freezes the capability composition and the
command-to-scope binding; it does not freeze the points, roster, or attendance
records.

The compiler rejects any payload other than `{ schemaVersion: 1 }` and produces a
deterministic, deep-frozen artifact.

## Data model

Migration `0024_attendance` adds four tables. Both `types.ts` and `migrations.ts`
must describe them identically; the schema drift gate compares every column and
nullability flag.

### `attendance_point`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text | deterministic id from the command |
| `activity_id` | text | activity reference |
| `key` | text | unique per activity |
| `name` | text | display name |
| `subject_types` | jsonb | non-empty subset of `participant`, `ticket`, `staff` |
| `active` | boolean | inactive points reject new check-ins |
| `revision` | integer | OCC for updates |
| `created_by` | text | actor id |
| `created_at` / `updated_at` | timestamptz | |

Constraint: `unique(activity_id, key)`.

### `attendance_staff`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text | deterministic id from the command |
| `activity_id` | text | activity reference |
| `display_name` | text | required |
| `actor_id` | text nullable | optional account link; never the check-in authority |
| `active` | boolean | inactive entries remain readable but reject new check-ins |
| `revision` | integer | OCC |
| `created_by` | text | |
| `created_at` / `updated_at` | timestamptz | |

### `attendance_fact`

Append-only fact log.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text | deterministic id from the command |
| `activity_id` | text | |
| `mode` | text | `formal` or `test`, from the session |
| `point_key` | text | |
| `subject_type` | text | `participant`, `ticket`, or `staff` |
| `subject_id` | text | registration id, ticket id, or roster id |
| `action` | text | `checkin` or `undo` |
| `note` | text nullable | bounded |
| `actor_id` | text | operator |
| `command_id` | text | idempotency receipt link |
| `occurred_at` | timestamptz | |

Indexes: `(activity_id, mode, point_key, occurred_at)`.

### `attendance_current`

Current projection updated in the same transaction as the fact.

| Column | Type | Notes |
| --- | --- | --- |
| `activity_id` | text | |
| `mode` | text | |
| `point_key` | text | |
| `subject_type` | text | |
| `subject_id` | text | |
| `status` | text | `present` or `undone` |
| `note` | text nullable | |
| `revision` | integer | increments on every transition |
| `updated_at` | timestamptz | |

Constraint: `unique(activity_id, mode, point_key, subject_type, subject_id)`.

## Subject resolution

- **Participant**: `subject_id` is a registration id. The command requires the
  registration to belong to the activity and be `approved`. A withdrawn or
  rejected registration cannot be checked in. Display labels come from the
  existing registration read model; attendance does not copy contact PII.
- **Ticket**: the API resolves `credential` (preferred) or `ticketId` to a
  ticket belonging to the activity. Revoked and expired tickets are rejected;
  `issued` and `redeemed` tickets are allowed. The ticket state is not changed.
- **Staff**: `subject_id` is an `attendance_staff.id`. The roster entry must
  belong to the activity and be active. The optional `actor_id` links the entry
  to an account for display only; the operator is always the command actor.

## Commands

| Command | Session | Permission | Behaviour |
| --- | --- | --- | --- |
| `attendance.point.create` | none | `attendance.manage` | create a point; key unique; subject types non-empty |
| `attendance.point.update` | none | `attendance.manage` | update name/subject types/active with expected revision |
| `attendance.staff.add` | none | `attendance.manage` | add a roster entry |
| `attendance.staff.update` | none | `attendance.manage` | update display name/account/active with expected revision |
| `attendance.checkin` | `checkin` | `attendance.manage` | write check-in fact and upsert current to `present` |
| `attendance.undo` | `checkin` | `attendance.manage` | write undo fact and set current to `undone` |

Check-in and undo call `requireRunningCommandSession`; the release policy must
bind the command to `checkin`. The session's mode is written to the fact and
current rows. The handler takes the activity row lock, validates the point,
subject, and current state, writes the fact and projection, and appends an
engine event for realtime invalidation.

Error codes include:

- `POINT_NOT_FOUND`, `POINT_INACTIVE`, `POINT_KEY_TAKEN`,
  `SUBJECT_TYPE_NOT_ALLOWED`;
- `SUBJECT_NOT_ELIGIBLE`, `CROSS_ACTIVITY`, `ALREADY_CHECKED_IN`,
  `NOT_CHECKED_IN`;
- `SESSION_NOT_RUNNING`, `COMMAND_SCOPE_UNDECLARED`, `SCOPE_NOT_AUTHORIZED`;
- `FORBIDDEN` for a missing `attendance.manage` permission.

Bounded inputs: point key 64 characters, point name 120, staff display name 120,
and check-in/undo note 500. The commands require an active activity.

## API

Add `apps/api/src/routes/attendance.ts` with `registerAttendanceRoutes(ctx)`.

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/activities/:id/attendance` | `config.access: "attendance"` |
| GET | `/api/activities/:id/attendance/staff` | `config.access: "attendance"` |
| POST | `/api/activities/:id/attendance/points` | `attendance.manage` |
| POST | `/api/activities/:id/attendance/staff` | `attendance.manage` |
| POST | `/api/activities/:id/attendance/checkin` | `attendance.manage` |
| POST | `/api/activities/:id/attendance/undo` | `attendance.manage` |

The list endpoint returns points, a summary (expected, present, undone) per
subject type, and paginated rows filtered by point, subject type, and a bounded
search string. It joins the approved registrations, activity tickets, and active
staff roster to the current projection for the requested mode; a missing mode
defaults to `formal` and is explicit in the response.

The check-in body is a closed union:

```ts
type CheckinBody =
  | { pointKey: string; subjectType: "participant"; subjectId: string; note?: string }
  | { pointKey: string; subjectType: "ticket"; ticketId?: string; credential?: string; note?: string }
  | { pointKey: string; subjectType: "staff"; subjectId: string; note?: string };
```

Exactly one of `ticketId` and `credential` is required for a ticket. The route
resolves a credential through the ticketing service and passes only the ticket
id to the runtime command.

`app.ts` adds `attendance` to `ReadAccess` and to `READ_ACCESS_PERMISSIONS` with
`attendance.manage` plus the existing operations/registration/ticket manage
permissions. The startup read-access check rejects an undeclared GET route.

Contracts live in `packages/contracts`; the route uses the closed TypeBox
validator, consistent with the tasks and voting routes.

## Web

- `apps/web/src/api/attendance.ts` and its tests.
- `apps/web/src/components/ops/AttendanceCard.tsx`: session status and
  open/close (existing execution endpoints, `session.manage`); point selector
  and add; tabs for participants, tickets, and staff; search; check-in, undo,
  and note; per-point counts. Write controls render only with
  `attendance.manage`.
- `apps/web/src/routes/opsActivity.tsx` mounts the card when the capability is
  enabled.
- The Live console adds a read-only attendance summary card; it does not write.
- The Studio Guided catalog adds an attendance question; the Expert definition
  can include the empty definition.

The Ops card subscribes to the existing `activity:<id>` invalidation topic and
refetches on an event; the HTTP list remains the recovery authority.

## Realtime

`AttendanceCheckedIn`, `AttendanceUndone`, `AttendancePointChanged`, and
`AttendanceStaffChanged` are engine events written to the outbox. The existing
activity invalidation topic causes subscribers to refetch. No new WebSocket
topic is introduced.

## Invariants

- `ATT-01` Attendance is observational; no other capability gates on it.
- `ATT-02` Check-in facts are append-only; undo is a fact, never a delete.
- `ATT-03` Facts and current rows are mode-partitioned; formal and test never
  mix.
- `ATT-04` Ticket check-in never changes ticket state or consumes redeem.
- `ATT-05` Check-in and undo require a running `checkin` session and the
  release's frozen command scope.
- `ATT-06` At most one current row exists per `(activity, mode, point,
  subject type, subject id)`.
- `ATT-07` Cross-activity subject references are rejected.
- `ATT-08` Raw ticket credentials never enter receipts, audit, outbox, logs, or
  command payload hashes.

## Testing

- Domain: registry composition, compiler, merged command scopes, and the
  `checkin` scope conflict.
- DB: migration, schema drift, unique constraints, and fact/current atomicity.
- Runtime: idempotent replay, check-in/undo, mode isolation, missing session,
  cross-activity, unapproved registration, revoked ticket, inactive point,
  inactive staff, and permission denial.
- API: read/write access, closed body validation, 404/409, and idempotency.
- Web: AttendanceCard states and filters; Live summary.
- E2E: open a check-in session, check in a participant, undo, check in a ticket
  by credential, and check in a staff roster entry.
- Gates: route-module boundary, capability boundary, schema drift, release
  artifacts, and documentation.

## Acceptance

1. The capability is optional and enabling it does not change any existing
   activity behavior.
2. A staff member with `attendance.manage` can open a check-in session, create a
   point, check in all three subject types, and undo without touching ticket,
   registration, competition, voting, or publishing facts.
3. Formal and test check-ins are isolated; the same subject can be present in
   both without leaking into the other mode's list.
4. A revoked or expired ticket cannot be checked in; a redeemed ticket can.
5. All focused tests, structural gates, schema drift, browser tests, and the
   documentation gate pass.

## Risks

- The activity row lock serializes check-ins; event volume is low and the
  unique-current constraint is the final guard.
- Staff roster is the only new source entity; it is activity-level and audited.
- Opening the check-in session needs `session.manage`; the Ops card states the
  required permission rather than silently failing.
- The capability is off by default; enabling it in a pack changes the Ops card
  but not any authority.
- Attendance intentionally has no check-out; adding it later must be a new fact
  type and projection column, not an in-place update of check-in rows.
