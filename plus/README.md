# ArtFlow-Plus

This directory is the v2 workspace. The Django application at the repository
root is the frozen v1 reference implementation; nothing here imports it.

## First vertical slice

`packages/domain` implements:

```text
Activity → Definition Draft → Compiler → Definition Release → Execution Run
```

It is deliberately small and pure:

- commands are functions with explicit inputs;
- every artifact is deep-frozen where it represents authority;
- OCC is a monotonic revision carried by the command, and a stale revision is
  refused with `STALE_REVISION`;
- a draft is the only editable definition surface;
- release requires a compiled plan whose content hash matches the draft;
- an execution run binds a released definition, never a draft;
- one activity has at most one running execution.

The rules come from `docs/invariants/` (LIFE-01/02, CONC-01, AUTH-01) and the
first golden fixture (`tests/golden/result-release-lifecycle.json`) will reuse
the same vocabulary when the result slice arrives.

## Run

From the repository root:

```powershell
npm run check:plus   # tsc --noEmit
npm run test:plus    # compile and run the node:test suite
```

The Gates workflow runs both on every `artflow-plus` push/PR.
