# M15.2 Tasks / Readiness Capability Design

## Intent

M15.1 exposes aggregate facts, but it does not give Ops a durable way to say
who owns the remaining work, when it is due, why it is blocked, or whether the
work was deliberately reopened. M15.2 adds an independent `tasks` capability
with a read-only readiness projection.

The capability owns task facts and task commands. It may reference another
capability as a source, but it never mutates registration, material,
competition, voting, publishing, archive, or activity-lifecycle authority.

## Scope and non-goals

In scope:

- frozen task templates in the Activity Definition Package;
- task instances bound to the released definition version that created them;
- assignment to a local actor;
- due time, status, blocked reason, completion reason, revision, and audit;
- explicit sync, assign, start, block, complete, and reopen commands;
- aggregate task list and readiness summary for Ops/Studio;
- task outbox events for query invalidation through the existing realtime core.

Out of scope for this slice:

- check-in, attendance, offline reconciliation, or ticket scanning;
- schedules, rooms, resources, shifts, or role-based assignment;
- automatic completion inferred from another capability's current state;
- task comments, attachments, notifications, recurring tasks, or reminders;
- changing a confirmed result, vote, roster, archive, or activity lifecycle;
- requiring a real activity rehearsal for acceptance.

## Capability contract

The registry entry is:

| Field | Value |
| --- | --- |
| identity | `tasks` |
| version | `1.0.0` |
| dependencies | none |
| surfaces | `ops`, `studio` |
| commands | `tasks.sync`, `tasks.assign`, `tasks.start`, `tasks.block`, `tasks.complete`, `tasks.reopen` |
| queries | `tasks.list`, `readiness.summary` |
| events | `tasks.changed` |
| permissions | `tasks.manage` |
| execution scopes | none; these are activity operations, not formal-session commands |

The capability is optional. A pack may enable it explicitly. A task template
may name a source capability only when that capability is also enabled in the
same definition package. This validation belongs to the tasks compiler, not to
the Activity kernel.

## Definition and release semantics

The `tasks` definition payload is schema version 1:

```ts
type TasksDefinition = {
  schemaVersion: 1;
  templates: readonly {
    key: string;
    title: string;
    sourceCapability: string;
    sourceKey: string;
    required: boolean;
  }[];
};
```

Compiler rules:

1. `key`, `title`, `sourceCapability`, and `sourceKey` are non-empty and have
   bounded lengths.
2. Template keys are unique within the definition.
3. `sourceCapability` is enabled in the complete composition. A template may
   use `activity` as the source for activity-wide work.
4. The compiled artifact is deterministic and deep-frozen like every other
   capability artifact.

`tasks.sync` reads the current released tasks artifact and creates one task
instance per `(activity_id, definition_version, template_key)`. Sync is
idempotent and refuses an activity without a released definition containing
the `tasks` capability. It never reads the current registry and never changes
an existing task's title, source, required flag, assignee, due time, status, or
reasons. A new definition release creates a new version of task instances;
old-version tasks remain historical and are not writable through current Ops
commands.

Historical v1 imports do not create task instances. Operational adoption may
create them only after a real Plus release contains the `tasks` capability.

## Task authority model

The durable task row is the authority for task status and assignment:

```text
pending → in_progress → done
   │           │          │
   └───────────┴──────→ blocked
                         │
                         └────→ in_progress

done → pending     (explicit reopen only)
```

Allowed transitions are enforced by the runtime service under the activity row
lock and task row lock. `block`, `complete`, and `reopen` require a non-empty
reason where the command semantics need an explanation. Every accepted command
uses the existing receipt → activity lock → domain validation → fact → audit →
outbox transaction. `expectedRevision` is required for task mutations and a
stale value returns the existing `STALE_REVISION` error path.

The first implementation assigns only to a local actor (`assigneeActorId`).
Role, shift, resource, and team assignment are deliberately deferred until
those concepts have their own authority model.

Command payloads are exact and intentionally small:

| Command | Required body fields | Effect |
| --- | --- | --- |
| `tasks.sync` | `definitionVersion` | Creates missing instances for that released version; no existing row changes |
| `tasks.assign` | `expectedRevision`, `assigneeActorId`, optional `dueAt` | Replaces the local actor assignment and due time |
| `tasks.start` | `expectedRevision` | `pending` → `in_progress` |
| `tasks.block` | `expectedRevision`, non-empty `reason` | `pending`/`in_progress` → `blocked` |
| `tasks.complete` | `expectedRevision`, non-empty `reason` | `in_progress` → `done` |
| `tasks.reopen` | `expectedRevision`, non-empty `reason` | `done` → `pending`; `blocked` → `in_progress` |

`tasks.assign` may clear an assignment by sending `assigneeActorId: null`.
Due times are ISO timestamps normalized by the API contract; a missing due time
means the task is not overdue. Invalid transitions return a stable domain
error and do not consume the command receipt.

## Database facts

Add a module-owned `task_item` table through the existing append-only migration
registry. The table stores:

- `id`, `activity_id`, `definition_version`, `template_key`;
- frozen `title`, `source_capability`, `source_key`, and `required`;
- `status`, `assignee_actor_id`, `due_at`;
- `blocked_reason`, `completion_reason`;
- `revision`, `created_at`, and `updated_at`.

Constraints and indexes:

- unique `(activity_id, definition_version, template_key)`;
- status check for `pending`, `in_progress`, `blocked`, `done`;
- non-empty checks for title/source/template key;
- activity foreign key and actor reference where supported by the existing
  schema conventions;
- index for `(activity_id, definition_version, status)` and due-time reads.

No readiness table is added. Readiness is calculated from current task rows and
is therefore not a second writable state machine.

## Commands and read surfaces

Commands are exposed as ordinary authenticated POST routes and carry the
existing idempotency key and expected revision fields:

```text
POST /api/activities/:id/tasks/sync
POST /api/activities/:id/tasks/:taskId/assign
POST /api/activities/:id/tasks/:taskId/start
POST /api/activities/:id/tasks/:taskId/block
POST /api/activities/:id/tasks/:taskId/complete
POST /api/activities/:id/tasks/:taskId/reopen
```

Read routes use the dedicated `tasks` surface and return only task fields and
source references:

```text
GET /api/activities/:id/tasks
GET /api/activities/:id/readiness
```

The read surface accepts `tasks.manage`, `studio.manage`, `competition.manage`,
`judge.manage`, `registration.manage`, `registration.review`,
`materials.manage`, `materials.review`, `grouping.manage`, `voting.manage`,
`result.manage`, `archive.manage`, or `ticket.manage`. A task read never grants
access to the source capability's private rows. The command permission is
`tasks.manage`.

The readiness response contains:

- total, required, done, open, blocked, overdue counts;
- counts by task status and source capability;
- a stable ordered list of open/blocked/overdue task IDs and template keys;
- current activity and definition version.

It does not claim that a source capability is semantically complete. A task
named `competition.round.lock` is only an operator declaration of work; the
competition service remains the authority for whether that round is locked.

## Runtime and realtime

The runtime owns template sync, transition validation, permission checks, and
read projections. It must not call source capability mutation services as a
side effect of task commands.

Each accepted mutation emits `tasks.changed` through the normal outbox. The
existing realtime core may invalidate Ops/Studio queries, but HTTP task reads
remain the recovery authority. No feature code opens a socket directly.

## UI

The Ops activity detail receives two read-only/mutation-safe sections:

- a task checklist showing title, source label, status, assignee, due time, and
  blocked/completion reason;
- a readiness summary showing counts and a clear empty state when the tasks
  capability is disabled or has no synced templates.

Mutation controls are shown only for `tasks.manage`. Every transition requires
the current revision returned by the last read, and stale responses show the
existing conflict error without silently refreshing away the user's work.

## Verification matrix

- domain: compiler validation, deterministic artifact, duplicate/source errors,
  registry composition and transition rules;
- DB: migration, unique versioned sync, status/revision facts, empty activity,
  due-time aggregation, and no source-row leakage;
- runtime: permission, activity/release binding, idempotent sync, all allowed
  and forbidden transitions, stale revision, audit/outbox transaction;
- API: startup read-surface declaration, 403/404, command idempotency, schema
  validation, and response redaction;
- web: checklist rendering, permission-gated controls, empty/blocked/overdue
  states, and stale mutation error;
- Plus check/build/full test suite and structural/documentation gates.

## Deferred follow-up

M15.3 may add check-in/attendance, but it must reference its own ticket and
scan facts rather than using task completion as attendance. M15.4 may add
schedule/program release, which can generate task templates through a new
source capability without changing the tasks authority model.
