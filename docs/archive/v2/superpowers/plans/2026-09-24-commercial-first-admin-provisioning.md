# Plan: Commercial First-Admin Provisioning

> This plan is executed inline in the current repository checkout. No subagents
> or linked worktrees are used.

## Goal

Create a safe, repeatable provisioning contract for a fresh ArtFlow
installation so a future launcher can create the first administrator without
reusing the development-only `seed_dev_admin` command or exposing an anonymous
HTTP takeover surface.

## Scope and non-goals

- Add a singleton installation state that records whether first-admin
  provisioning has completed.
- Add an authority-guarded service and a non-resetting management command.
- Keep `seed_dev_admin` development-only and behaviorally unchanged.
- Extend `doctor` and deployment documentation with a non-secret provisioning
  status.
- Add regression coverage for idempotency, collision handling, password
  validation, authority bypasses, migration backfill, and safe diagnostics.
- Do not add a public setup route, change admin login semantics, change
  competition authority, or add licensing/DRM in this slice.

## Design invariants

1. A fresh installation has exactly one installation-state row and no effective
   administrator; provisioning is required.
2. The first successful provisioning transaction creates one active role-based
   administrator and marks the state initialized while holding the singleton
   row lock.
3. Once initialized, provisioning cannot update, reset, or create another
   administrator through the new command.
4. An existing effective administrator also blocks provisioning, even if a
   legacy or manually repaired state row is not initialized.
5. The installation state cannot be changed through direct runtime ORM writes;
   only the account authority service may mark it initialized.
6. Passwords never appear in command output, audit fields, or diagnostics.
7. The command accepts a password from hidden interactive input or an explicit
   password-only stdin mode; it never accepts a password as a command-line
   argument.
8. `doctor` reports `required`, `complete`, or `inconsistent` without exposing
   credentials and without treating a fresh, not-yet-provisioned installation
   as a database/configuration failure.

## Implementation steps

### 1. Contract tests first

Update `accounts/tests.py` and `common/tests.py` with failing tests covering:

- first provisioning creates the expected least-privilege administrator;
- second provisioning and legacy-admin provisioning fail closed;
- weak/blank/duplicate usernames and blank passwords are rejected;
- direct state `save`, `update`, and `delete` cannot bypass account authority;
- audit output is non-secret and records the bootstrap event;
- `doctor` reports a safe provisioning status;
- the command uses hidden input / stdin and never echoes a password.

### 2. Installation state and service

- Add `accounts.InstallationState` with a fixed singleton primary key,
  `initialized_at`, and an authority-guarded manager/model write path.
- Add a migration that creates the singleton row and marks it initialized when
  an existing database already contains an effective admin.
- Add `provision_first_admin()` in `accounts.services` using one transaction,
  `select_for_update()` on the singleton row, Django password validation,
  `ACCOUNT_AUTHORITY`, and a non-secret bootstrap audit event.

### 3. Management command

Add `manage.py provision_first_admin` with:

- required explicit username (`--username` or
  `ARTFLOW_INITIAL_ADMIN_USERNAME`);
- hidden interactive password input by default;
- `--password-stdin` for launcher/container automation;
- no reset/force option and no password command-line argument;
- stable failure messages and no secret output.

### 4. Diagnostics and documentation

- Extend `doctor` with the provisioning status.
- Document the command as the commercial/bootstrap path in README and
  deployment/development docs; retain `seed_dev_admin` as local-development
  only.
- Add the one-time bootstrap variables/usage guidance without placing sample
  credentials in tracked files.

### 5. Verification and delivery

Run focused tests first, then Django check/migration check, Ruff, mypy,
project Pyright, client/docs gates, and the full Django suite. Perform two
self-review passes: first against the provisioning/security contract, then
against authority, type, migration, and secret-leak consistency. Commit the
test, implementation, and documentation changes separately, merge with
`--no-ff` into `main`, push, and verify remote CI.
