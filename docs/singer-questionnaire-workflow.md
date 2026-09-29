# Singer questionnaire workflow

How a singer contest's registration form is produced, filled, reviewed, and carried across
a ruleset change. The form is not code: it is part of the frozen ruleset, so changing the
questions is a ruleset edit with a version, a freeze, and an authority hash.

Read [the development baseline](development-baseline.md) for the operating procedures this
builds on, and [`singer-final-production-flow.md`](singer-final-production-flow.md) for the
onsite flow that follows registration.

## The shape

```text
RulesetVersion (CURRENT + FROZEN)
        │
        ├── nodes / checkpoints        → the contest
        └── questionnaire              → the registration form
                 │
        QuestionnairePlan  ──►  participant page  ──►  QuestionnaireResponse
                 │                                          │
                 └── answers never feed the scorer ─────────┘
```

The questionnaire is a **second DSL inside the ruleset definition root**, with its own
`schema_version` so it can evolve independently of the flow DSL. It freezes with the
ruleset and nowhere else: editing one question moves the ruleset's `content_hash` and, with
it, the `authority_hash` a stage result is audited under. There is deliberately no separate
questionnaire authority to keep in sync.

## Order of operations

The product order is the reverse of what the old fixed form allowed:

1. **Confirm the ruleset.** A ruleset is frozen *before* anyone registers. Roster-dependent
   facts (a `top10` quota, a vote session's candidate list, full/subset round coverage) are
   **deferred** at freeze and recorded as `Severity.DEFERRED` issues, not invented as zeros.
2. **Open registration.** The participant page renders from the frozen plan.
3. **Close and review.** The roster becomes final; `prepare_round` and `open_vote_session`
   re-run the deferred checks against it and fail closed.
4. **Run the contest.**

## What each part is for

| Concern | Where | Rule |
|---|---|---|
| Form definition | `questionnaire/schema.py` | Typed, forward-only, no `eval`. Conditions are a data AST; an answer condition may only name an earlier question. |
| Compiled form | `questionnaire/compiler.py` | The single structure the renderer, the response validator and the upload path read. `schema_hash` is over the normalised form. |
| Freeze coupling | `questionnaire/cross_domain.py` | A question may bind only a round the ruleset binds. It need **not** have an `ASSESS` node — a materials-only round is legal. |
| Draft and submit | `questionnaire/registration.py` | Opening the form creates the draft; submitting reloads the frozen version, rebuilds the server context, re-evaluates every condition and proves the due-now required answers. |
| Answers | `questionnaire/models.py` | One response per (registration, ruleset version, questionnaire key). Bound answers live on the registration; file answers on their question key. |
| Files | `files/services.py` | `store_questionnaire_file` takes a *question*, never a purpose: the frozen plan decides which technical purpose that question accepts. |
| Across versions | `questionnaire/successor.py` | A key that keeps its type, binding and file purpose carries its answer. A key that changes meaning is refused at freeze — make a new key. |
| Staff editor | `questionnaire/staff_views.py` | Designer, JSON mode, and four preview states. Patches the `questionnaire` section; a frozen version is read-only. |

## Invariants worth knowing

- **Answers never score.** `questionnaire` and `ruleset` are compiled together at freeze and
  stay independent everywhere else; a resolved board is identical across a questionnaire
  change.
- **The submission context is built, not accepted.** There is no request parameter a browser
  could put an activity phase or a qualification into.
- **A bound answer has one copy.** It is written to the registration from the first
  keystroke and never also stored in the response.
- **Required-ness is conditional on visibility**, and separate from due-ness: a question
  hidden by its own condition can never be missing, and a `before_round` question is shown
  early but not owed until its round starts.
- **Forward-only is structural.** A condition may only look backwards, which is why cyclic
  visibility cannot be expressed — and why the designer re-validates a move rather than
  letting the operator build a cycle.

## Legacy path — deprecation status

The fixed singer apply form still exists and still works. It is on the **Contract** step of
the Expand → Migrate → Switch → Contract sequence and is **not yet removed**:

| Legacy | Status |
|---|---|
| `singer_contest.views.apply_view` and its template | Superseded by the questionnaire page. Still routed; retire once rehearsal confirms the new path. |
| `SingerRegistration.song_name` | Legacy. Now `blank=True, default=""` — a draft exists before anyone has typed anything, and the per-round songs live in the questionnaire. Not dropped: legacy data reads it. Current display code uses the read-only projections in `questionnaire/projection.py`: round-aware surfaces read the frozen `<round-key>.song`, while generic lists say `多轮曲目` instead of guessing one round. |
| `files.services.DEFAULT_SINGER_REQUIREMENTS` | Legacy. The fallback requirement table for activities with no configured requirements and no frozen questionnaire. |
| Purpose-only singer uploads (`store_submission_file`) | Kept. A legacy upload still has `question_key=""` and still replaces itself by purpose; the farewell-show program path is unchanged. |

Do not delete the columns before a rehearsal has confirmed the new path end to end.

## Verifying a change

```powershell
uv run python manage.py test questionnaire ruleset files singer_contest
pwsh -NoProfile -File scripts/check_docs.ps1
npm run check:client
```

The full suite, the PostgreSQL acceptance run, and the browser smoke are the release gates;
see [the development baseline](development-baseline.md).
