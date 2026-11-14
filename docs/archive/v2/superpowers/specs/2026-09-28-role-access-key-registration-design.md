# Role Access-Key Registration and Login Design

## Status

Approved design for implementation on the `feat/role-access-key-registration`
branch. This change makes account onboarding understandable for an
学院级 ArtFlow deployment without introducing invitations, tenants, or a
general IAM subsystem.

## Goal

Give participants, staff, and administrators distinct, direct registration
and login flows. Staff and administrators must provide their role-specific
access key in addition to username and password for both registration and
login.

## Role model

| Role | Registration | Login | Scope |
| --- | --- | --- | --- |
| Participant | Username and password | Username and password | Own registrations, materials, and profile |
| Staff | Username, password, and `STAFF_ACCESS_KEY` | Username, password, and `STAFF_ACCESS_KEY` | Activity operations |
| Admin | Username, password, and `ADMIN_ACCESS_KEY` | Username, password, and `ADMIN_ACCESS_KEY` | Users, configuration, and high-risk operations |
| Judge | No account registration | Existing temporary QR/grant flow | Current activity, round, seat, and live context |

The access keys are shared deployment secrets for the corresponding role; they
are not per-user passwords and are not stored in the database.

## Routes and user experience

The root account routes are explicit and role-labelled:

```text
/register/          participant registration
/register/staff/    staff registration
/register/admin/    administrator registration
/login/             identity selection
/login/participant/ participant login
/login/staff/       staff login
/login/admin/       administrator login
```

The identity-selection page links each role to its matching login and
registration page and explains that judges use the event QR/grant flow rather
than a normal account.

Registration pages contain only the fields needed for that role:

- participant: username, password, confirmation;
- staff: username, password, confirmation, staff access key;
- admin: username, password, confirmation, admin access key.

The interface must not expose a role dropdown or implementation terms such as
`InstallationState`, provisioning, or authority.

## Configuration contract

Replace `ADMIN_LOGIN_KEY` with two independent settings:

```text
STAFF_ACCESS_KEY
ADMIN_ACCESS_KEY
```

Both are read only from environment configuration, rejected when empty or a
known placeholder in production, and documented in both environment examples
and deployment/diagnostic documentation. The existing admin recent-verification
window remains unchanged; successful administrator login marks the current
session verified exactly as today.

The old `ADMIN_LOGIN_KEY` configuration contract is intentionally removed; no
backward-compatible alias is added. Deployment environments must update both
keys before restarting the service.

## Authority and lifecycle

All three registration paths use account service functions:

```text
register_participant_account(...)
register_staff_account(..., access_key)
register_admin_account(..., access_key)
```

The services validate password policy, compare the role key with
`constant_time_compare`, create the role under `ACCOUNT_AUTHORITY`, and write
only non-secret audit information. Failed key checks must not create a user.

Administrator registration preserves the existing `InstallationState` safety
invariant:

- when provisioning is `required`, the first admin registration delegates to
  the existing first-admin authority path and marks installation initialized;
- when provisioning is complete, the same page creates another admin through a
  normal account-authority service;
- no user can remove or deactivate the last effective administrator through the
  existing admin role-management services.

The existing `change_user_role` and `set_user_active` services remain the only
role/status mutation paths. Staff cannot manage users or promote accounts.
Judges remain outside the persistent `User` role model.

## Authentication and security behavior

- Staff and admin login forms require username, password, and the matching
  role key.
- A participant cannot authenticate through either staff or admin login.
- A staff account cannot authenticate through admin login.
- The admin login continues to call `mark_admin_verified` after successful
  credential and key validation.
- Participant, staff, and admin credential submissions continue using the
  existing shared credential rate-limit buckets.
- Keys never enter `User`, `AuditLog`, access logs, response bodies, or session
  data. They are compared in memory only.
- Error messages may identify the matching role-key failure as requested, but
  all credential paths remain rate-limited.
- Key rotation is operationally handled by changing environment configuration,
  restarting the service, and clearing active sessions; session-generation
  binding is explicitly out of scope.

## Migration and compatibility

No database schema migration is required. Existing users retain their current
roles and passwords. Existing `ADMIN_LOGIN_KEY` environment values must be
renamed to `ADMIN_ACCESS_KEY`; the application deliberately fails closed when
the new required production variables are missing.

The generic participant registration route remains `/register/`; staff and
admin registration are new explicit routes. The prior `/setup/` route and page
are removed rather than kept as a compatibility alias; its authority service
and installation state remain for the first-admin branch of administrator
registration.

## Verification requirements

The implementation must add tests for:

1. Correct registration creates the intended role.
2. Incorrect role keys create no account.
3. Correct role-key login succeeds only at the matching role entry point.
4. Cross-role login attempts fail.
5. Admin registration preserves first-admin initialization and last-admin
   protection.
6. Staff cannot mutate roles or account status.
7. Access keys are absent from audit records and rendered responses.
8. All role login/registration paths use the shared credential throttling
   behavior.
9. The identity-selection page exposes all three role paths and the judge
   temporary-access explanation.

The focused Django account gate, production configuration tests, project
Pyright gate, frontend/static checks, and the relevant Playwright browser
flows must pass before merge.
