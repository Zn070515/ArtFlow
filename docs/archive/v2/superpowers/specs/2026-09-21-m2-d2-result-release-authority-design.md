# M2-D2 Result Release Authority Design

## Status

Approved implementation direction for M2-D2. This document separates the
editorial state of `PublicPost` from the business authority that makes a
confirmed result public.

## Goal

Make a result public only through an explicit, audited release of the current
closed `StageResult`. A confirmed result may remain internal; publishing a
`PublicPost` must never by itself release a result.

## Contract

The result authority chain is:

```text
raw facts locked
  -> resolver candidate
  -> READY_TO_CONFIRM
  -> CONFIRMED
  -> explicit ResultRelease ACTIVE
  -> public visibility
```

`PublicPost.Status.PUBLISHED` remains an editorial/content state. It is not a
replacement for `RELEASED`, and `RELEASED` must not be added as another
`PublicPost.Status` value. Existing announcement, showcase, registration,
voting, and normal article publication semantics remain unchanged.

For `RESULT_PUBLICATION` posts, public visibility requires all of the
following at read time:

1. The post is editorially `PUBLISHED` and is not related to a TEST activity.
2. The post has an active `ResultRelease`.
3. The release targets the same activity as the post and an exact
   `StageResult`.
4. The target stage result is `CONFIRMED`, is the latest result version for
   its activity/stage, and is bound to the current frozen ruleset.
5. The post version and the result version captured by the release still
   match. Any post edit, result unlock, or newer result version fails closed.

The release service must additionally require the M2-D1 closure to be
closeable, a FORMAL activity, a current confirmed stage result, current
ruleset binding, current admin re-authentication, and a non-empty audit note.
Re-confirmation never automatically creates a release.

## Release record

Add `public_portal.ResultRelease` with historical rows and explicit lifecycle
states `ACTIVE`, `REVOKED`, and `SUPERSEDED`. Each row stores:

- the `PublicPost` and exact `StageResult` it releases;
- the post version and result version captured at release time;
- the bound ruleset version, authority hash, and input fingerprint for
  internal provenance;
- releaser/time, lifecycle transition actor/time, and audited reason.

The model must enforce at most one active release per post and per exact stage
result. Model/service validation must reject a post whose related activity does
not equal the stage result activity. Provenance fields are never rendered to
the public and must not contain raw credentials, tokens, or unrelated personal
data.

## Mutation boundaries

`public_portal.services` owns the transaction-safe commands:

- `release_result_post(post, stage_result, operator, note)`;
- `revoke_result_release(post, operator, note)`;
- `supersede_releases_for_stage_result(stage_result, operator, note)`.

The commands first call the existing `lock_activity_for_action(activity,
ActivityAction.PUBLISH_RESULT)` policy, then lock the activity, target stage
result, post, and relevant active release rows in the repository's established
lock order. The HTTP boundary validates the current admin session; the service
also requires the current admin identity with `require_current_admin`, so a
caller cannot bypass either layer. Commands validate the closure and authority
chain server-side and write distinct audit actions. An active result release
freezes the post's content and activity binding; staff must revoke before
editing or moving it. Unlocking a released stage result supersedes its active
releases in the same transaction. Public query validation remains fail-closed
as a second layer.

Direct `post_create`/`post_edit` requests may create or edit result content,
but setting `PUBLISHED` never creates a release and never makes a result post
public. Dedicated POST-only release/revoke endpoints are the only public
authority mutation surface.

## Read boundaries

`PublicPost.published_public()` remains the single public-post queryset API,
but its result-publication branch must require the active, exact, current
release contract above. Home, post detail, result list, and public media
queries must all use that same visibility boundary; no query may expose media
for a result post merely because `post.status == PUBLISHED`.

Staff preview remains able to show unpublished content without changing public
visibility. Archive/public-content indexes may record editorial status and
release lifecycle separately; they must not label `PUBLISHED` as `RELEASED`.

## School-facing boundary

M2-D2 provides application-level release provenance only. It does not claim
school SSO, MFA policy approval, TLS, WAF, volumetric DDoS protection,
retention approval, or deployment ownership. Public result content remains an
explicitly reviewed editorial payload; this slice does not auto-publish
student IDs, phone numbers, private files, or raw scoring facts.

## Required evidence

Tests must cover:

- direct result-post `PUBLISHED` without release remains private;
- active release is visible through home, detail, result list, and media paths;
- cross-activity, cross-stage, stale-version, old-ruleset, TEST-activity, and
  forged URL/query attempts fail closed;
- revoke, supersede, unlock, newer result version, and post-edit invalidation;
- active release blocks post editing/reparenting until revoked;
- concurrent release/revoke has one authoritative outcome and one valid audit
  trail on PostgreSQL;
- release/revoke requires current admin verification and a reason, with no
  secret, token, full fingerprint, or private student data in public output;
- archive/export metadata distinguishes editorial publication from result
  release.

The existing Compose backup/restore gate must also be repaired and rerun before
M2-D2 is considered ready. The repair must preserve source services and
volumes, wait for the isolated restore target by condition, and retain enough
diagnostics to distinguish a stopped restore server from a restore-client
failure.

## Non-goals

- SSO/CAS/OIDC integration;
- replacing the generic CMS/editorial workflow;
- automatic public-result rendering from every internal score row;
- external WAF, DDoS, TLS, or school-network validation;
- deleting or rewriting historical result release records.
