# ArtFlow-Plus GOAL

> Status: Adopted (2026-10-19); the product and architecture identity authority
>
> Scope: ArtFlow-Plus / ArtFlow v2 and later
>
> This document defines **what ArtFlow is, what it must become, and the architectural principles that must remain true as it evolves**.
>
> Concrete frameworks, libraries, database access layers, deployment manifests, milestone plans, and temporary implementation decisions belong in ADRs and roadmap documents rather than this GOAL.

---

# 1. What ArtFlow Is

**ArtFlow-Plus is a composable operations platform for competitions and complex events.**

It allows organizers to design how an event should work, prepare the people and resources required to run it, reliably execute it on site, and provide participants, judges, staff, and audiences with the appropriate interaction surfaces.

ArtFlow is not tied to one competition format, one event type, or one organization workflow.

An event is assembled from reusable **Capabilities**, configured through an **Activity Definition**, executed by a shared **ArtFlow Engine**, and exposed through four stable product surfaces:

- **ArtFlow Studio** — design
- **ArtFlow Ops** — prepare and operate
- **ArtFlow Live** — execute on site
- **ArtFlow Portal** — participate and access

The same capability may contribute functionality to several surfaces while sharing one authoritative domain model.

---

# 2. Why ArtFlow Exists

Complex events are rarely difficult because they lack a form, spreadsheet, voting page, schedule, or task list.

They are difficult because these pieces must remain consistent while:

- plans are still changing;
- information is incomplete;
- multiple staff members work simultaneously;
- participants submit materials asynchronously;
- judges and audiences interact during a live event;
- rules determine consequential outcomes;
- networks and devices fail;
- corrections must be made without destroying history;
- public information must remain consistent with the formally confirmed result.

Generic form builders, spreadsheets, workflow tools, task managers, and tournament systems each solve part of this problem.

ArtFlow exists to connect these parts using **event-domain semantics and explicit authority**.

Its purpose is not to create more configurable fields.

Its purpose is to make a complex event **understandable, executable, recoverable, and explainable**.

---

# 3. Product Structure

ArtFlow has four user-facing product surfaces.

They are independently understandable but operate on the same activity and capability model.

## 3.1 ArtFlow Studio

Studio answers:

> **How should this event work?**

Studio is the design and configuration environment.

It is responsible for:

- activity structure;
- enabled capabilities;
- forms and information collection;
- competition and evaluation rules;
- schedules and constraints;
- roles and responsibilities;
- resource requirements;
- workflows and approval conditions;
- publication rules;
- live-operation configuration;
- cross-capability bindings.

Studio must support progressive complexity.

### Guided Mode

For users who know the event but do not know ArtFlow's internal model.

Example questions:

- Is registration required?
- Will there be judges?
- Are there multiple rounds?
- Is audience voting required?
- Will programs need materials?
- Are rehearsal and formal execution separate?

### Professional Mode

Structured editors for:

- forms;
- competition structures;
- schedules;
- scoring;
- roles;
- tasks;
- resources;
- publication;
- live operations.

### Expert Mode

Direct access to advanced definitions, bindings, rules, diagnostics, and dependency relationships.

Advanced flexibility must never force ordinary users to understand the Expert representation.

---

# 3.2 ArtFlow Ops

Ops answers:

> **Are we ready to run this event?**

Ops manages real operational state before and around execution.

Typical responsibilities include:

- registrations;
- submissions;
- material review;
- participant roster;
- programs;
- judge assignment;
- staff assignment;
- tasks;
- schedules;
- resources;
- rehearsals;
- checklists;
- conflicts;
- missing information;
- operational risks;
- preparation status.

Studio describes the intended system.

Ops manages the actual people, materials, resources, and work required to make that system real.

Ops must make incomplete or problematic preparation visible rather than silently inventing defaults.

---

# 3.3 ArtFlow Live

Live answers:

> **What is happening now, and what should happen next?**

Live is the event command center.

Depending on enabled capabilities, it may expose:

- current performance or match;
- next program;
- judge readiness;
- scoring progress;
- audience voting state;
- participant check-in;
- stage and rehearsal state;
- staff tasks;
- resource status;
- live schedule;
- cues;
- incidents;
- HOLD / pause / recovery controls;
- result readiness;
- authoritative operator actions.

Live is not merely a realtime dashboard.

It is the operational surface for safely executing an event under time pressure.

Realtime communication enhances Live but does not become the source of authority.

Loss of realtime infrastructure must degrade visibility before it destroys correctness.

---

# 3.4 ArtFlow Portal

Portal answers:

> **How does someone outside the organizing team interact with this event?**

Portal provides role-appropriate external experiences.

It may expose:

### Participant Portal

- registration;
- forms;
- submissions;
- materials;
- review state;
- schedules;
- personal event information;
- results.

### Judge / Reviewer Portal

- assigned work;
- current evaluation context;
- scoring or reviewing;
- submission state;
- progress.

### Audience Portal

- event information;
- current program;
- voting;
- tickets;
- announcements;
- results.

### Volunteer / Staff Portal

- assignment;
- shift;
- check-in;
- task;
- limited operational actions.

### Public Portal

- activity introduction;
- schedule;
- programs;
- participants;
- public results;
- public documents.

Portal must expose only the information and authority appropriate to that actor.

A public event identifier is a locator, not an authorization credential.

---

# 4. ArtFlow Engine

Studio, Ops, Live, and Portal share one domain runtime:

**ArtFlow Engine**

Engine is not primarily a user-facing product.

It provides the authoritative mechanics behind every product surface.

Engine is responsible for concepts such as:

- Activity
- Capability
- Definition
- Compilation
- Release
- Command
- Authorization
- Execution Session
- Fact
- Decision
- Snapshot
- Audit
- Projection
- Recovery

A rule configured in Studio, operated in Ops, executed in Live, and observed through Portal must retain the same meaning across all four surfaces.

No surface may invent an independent interpretation of authoritative business facts.

---

# 5. Platform Foundation

Below Engine is the common technical foundation.

Typical responsibilities include:

- identity and sessions;
- capability credentials;
- organization context;
- authorization primitives;
- IDs and clocks;
- audit infrastructure;
- media and file access;
- durable storage;
- background work;
- realtime transport;
- observability;
- backup and restoration;
- import/export;
- deployment diagnostics.

Platform provides mechanisms.

It must not decide competition winners, registration eligibility, vote validity, or other domain-specific outcomes.

---

# 6. Capability Model

A **Capability** is the primary unit of functional growth in ArtFlow.

Examples may include:

- Registration
- Questionnaire
- Materials
- Participant Directory
- Program Management
- Competition
- Evaluation
- Scheduling
- Tasks
- Resources
- Rehearsal
- Ticketing
- Check-in
- Voting
- Publishing
- Results
- Archive
- Incident Management

A capability owns its business semantics.

It may contribute functionality to several product surfaces.

For example:

| Capability | Studio | Ops | Live | Portal |
| --- | --- | --- | --- | --- |
| Registration | form definition | review and roster | check-in status | registration |
| Evaluation | scoring definition | judge assignment | scoring control | judge terminal |
| Scheduling | constraints | schedule editing | run of show | public/personal schedule |
| Voting | ballot definition | eligibility | open/close/status | audience voting |

A Capability is therefore not equivalent to a page, menu, database table, or service.

It is a coherent domain ability.

---

# 7. Capability Independence

Every authoritative fact has exactly one owning capability.

Capabilities communicate through explicit contracts rather than by reaching into one another's internal state.

A capability may:

- issue commands to a published contract;
- consume published queries;
- consume immutable domain events;
- reference stable identities;
- bind through declared cross-capability relationships.

A capability must not:

- directly mutate another capability's internal state;
- duplicate another capability's authoritative selector;
- independently reinterpret another capability's business fact;
- bypass another capability's command rules through persistence access.

Physical code layout and database layout may evolve.

**Domain ownership must remain explicit.**

---

# 8. Activity

An **Activity** is the root container in which capabilities cooperate.

Activity itself should remain deliberately thin.

It owns concepts such as:

- identity;
- title and metadata;
- ownership;
- high-level lifecycle;
- enabled capabilities;
- active definition release;
- common policy;
- public identity.

Activity must not accumulate every capability's state into one giant object.

Its global lifecycle should remain coarse, for example:

```text
DRAFT → ACTIVE → CLOSED → ARCHIVED
```

Individual capabilities own their own richer lifecycles.

For example:

```text
Registration:
DRAFT → OPEN → REVIEW → FINAL

Competition:
PREPARING → READY → RUNNING → CLOSED

Voting:
DRAFT → OPEN → CLOSED

Publishing:
PRIVATE → READY → RELEASED → REVOKED
```

ArtFlow must not force inherently parallel operational processes into one global linear phase.

---

# 9. Activity Definition

The configurable description of an activity is an **Activity Definition Package**.

It is not one universal workflow graph.

A Definition Package contains:

- manifest;
- enabled capabilities and versions;
- capability-specific definitions;
- policies;
- cross-capability bindings;
- lifecycle requirements;
- publication configuration;
- compatibility information.

Conceptually:

```text
Activity Definition
├── manifest
├── capabilities
├── policies
├── bindings
│
├── registration/
├── competition/
├── evaluation/
├── scheduling/
├── voting/
└── ...
```

Each capability may own its own definition language and compiler.

The Activity compiler coordinates those capability compilers and verifies their cross-capability relationships.

This prevents ArtFlow from becoming a universal arbitrary workflow programming environment.

---

# 10. Draft, Compile, Release

User-editable configuration is always a **Draft**.

Drafts may be incomplete.

Drafts may explicitly contain unresolved or unknown information.

A Draft becomes executable only after compilation.

Compilation performs, as appropriate:

- schema validation;
- reference validation;
- dependency validation;
- capability compatibility checks;
- business-rule validation;
- conflict detection;
- cross-capability binding validation;
- diagnostic generation;
- executable-plan generation.

Diagnostics distinguish concepts such as:

- ERROR
- DEFERRED
- WARNING
- REVIEW
- INFORMATION

Unknown information must not be silently converted to zero, false, empty, or another invented fact.

A successful configuration can be published as an immutable **Definition Release**.

Formal execution binds to a released definition, never to a mutable draft.

Corrections create new versions rather than silently rewriting history.

---

# 11. Activity Packs

An **Activity Pack** is an opinionated composition of capabilities, defaults, definitions, and user guidance.

A Pack is not an Activity subclass.

Examples may include:

### Singer Competition Pack

Registration + Questionnaire + Materials + Competition + Evaluation + Voting + Publishing + Archive

### Stage Show Pack

Program + Materials + Scheduling + Tasks + Resources + Rehearsal + LiveOps + Publishing + Archive

### Tournament Pack

Registration + Teams + Competition + Match + Ranking + Scheduling + Publishing

### Review / Award Pack

Submission + Review + Evaluation + Selection + Publishing

Users may start from a Pack and then enable, disable, or customize compatible capabilities.

ArtFlow must allow hybrid activities without inventing a new hard-coded Activity Type.

---

# 12. Competition as a Capability

Competition is an important and deep ArtFlow capability, but it is not the root architecture of ArtFlow.

Competition may support different stage mechanics such as:

- judged performance;
- multi-round evaluation;
- group / round-robin competition;
- head-to-head match;
- elimination bracket;
- Swiss-style competition;
- leaderboard / points;
- race / time trial;
- selection and advancement;
- custom compositions built from supported mechanics.

Competition-specific concepts such as Round, Match, Panel, Score, Ranking, Advancement, Tie Resolution, or Podium belong to the Competition / Evaluation capabilities rather than the universal Activity kernel.

ArtFlow must never distort non-competition activities merely to fit a competition DAG.

---

# 13. Execution Sessions

Runtime execution is represented by scoped **Execution Sessions**.

An Activity may contain multiple execution scopes.

Examples include:

- rehearsal;
- formal performance;
- judging round;
- check-in;
- voting session;
- stage-show execution.

An Execution Session binds to:

- an Activity;
- a Definition Release;
- a scope;
- a mode;
- authoritative runtime facts.

Modes must distinguish at minimum:

- TEST / REHEARSAL
- FORMAL

Test execution must never contaminate formal facts.

ArtFlow must not assume that an entire Activity can have only one running process.

Instead, capabilities declare which execution scopes conflict and therefore cannot operate simultaneously.

---

# 14. Facts, Decisions, Snapshots and Projections

ArtFlow distinguishes four fundamentally different forms of data.

## Facts

Things that happened or were authoritatively submitted.

Examples:

- registration submitted;
- material reviewed;
- score submitted;
- ballot accepted;
- participant checked in.

## Decisions

Conclusions produced from facts and explicit rules.

Examples:

- participant approved;
- ranking computed;
- contestant advanced;
- result confirmed.

Computed candidates and formally confirmed decisions must remain distinguishable.

## Snapshots

Immutable representations created at authority boundaries.

Examples:

- frozen definition;
- finalized roster;
- panel snapshot;
- confirmed result;
- public result release;
- archive package.

Later edits must not silently rewrite a historical snapshot.

## Projections

Optimized representations for user interfaces, lists, realtime views, search, dashboards, or reports.

A projection may be rebuilt.

A projection is never the authority merely because it is convenient to query.

---

# 15. Authority Model

Every consequential mutation must occur through an explicit authoritative command.

Commands must make relevant context explicit, including where applicable:

- actor;
- activity;
- capability;
- expected revision;
- execution scope;
- idempotency identity;
- payload.

Commands must enforce:

- authentication;
- authorization;
- ownership;
- state transition rules;
- optimistic concurrency;
- relevant database uniqueness;
- idempotency;
- audit requirements.

Formal facts cannot be silently overwritten because a client is stale.

Conflicts must be visible and recoverable.

---

# 16. Determinism and Explainability

Where ArtFlow computes consequential outcomes, the computation must be deterministic.

Given:

- the same released rules;
- the same authoritative inputs;
- the same explicit decisions;

ArtFlow must produce the same result.

Examples include:

- competition rankings;
- advancement;
- audience-vote score conversion;
- result candidates;
- eligibility;
- dependency resolution.

Ambiguity must not be resolved using accidental ordering.

If the system cannot legally determine an outcome, it should produce a state such as HOLD / NEEDS_DECISION rather than invent a winner.

Important calculations must be explainable from their inputs and rule versions.

---

# 17. Recovery Is a First-Class Feature

Complex live events inevitably experience:

- device failures;
- network failures;
- incorrect submissions;
- participant absence;
- judge replacement;
- late material;
- operator mistakes;
- result corrections.

ArtFlow must provide explicit recovery seams.

Recovery must:

- minimize the writable scope;
- preserve historical authority;
- record actor and reason;
- be resumable;
- be understandable from the UI;
- produce a new authoritative version when necessary.

"Reset everything" is not a normal recovery strategy.

---

# 18. Realtime Is an Enhancement, Not Authority

Realtime transport may improve:

- presence;
- progress;
- live dashboards;
- collaborative editing;
- notifications.

But the correctness of:

- registration;
- scoring;
- voting;
- confirmation;
- publication;
- archiving;

must not depend upon successful delivery of a realtime message.

A client that reconnects must be able to recover current state from authoritative data.

---

# 19. Collaboration

ArtFlow should support multiple organizers working at the same time.

Different collaboration models apply to different data.

### Draft collaboration

Collaborative techniques may be used for:

- planning documents;
- editable definitions;
- non-authoritative notes;
- layout configuration.

### Authoritative operations

Formal business commands use:

- explicit revision;
- conflict detection;
- authorization;
- server-side transaction semantics.

Collaborative editing must not turn formal competition results or votes into eventually-consistent shared documents.

---

# 20. Customization

ArtFlow supports customization in layers.

### Level 1 — Activity Pack

Choose a known event shape and use safe defaults.

### Level 2 — Capability Composition

Enable or disable compatible abilities.

### Level 3 — Professional Definition

Configure forms, competition mechanics, workflows, schedules, bindings, policies, and publication behavior.

### Level 4 — Developer Extension

Add new capability implementations, mechanics, or integrations through controlled extension contracts.

The power of Level 4 must not leak into the usability requirements of Level 1.

Users should not need to become low-code platform developers merely to organize an event.

---

# 21. User Experience Principles

ArtFlow should be usable by people who understand their event but may not understand software architecture.

Therefore:

- show business language instead of internal implementation terms;
- progressively reveal complexity;
- distinguish unknown from invalid;
- explain why an action is blocked;
- show how to recover;
- present current operational risk clearly;
- minimize live-event interaction cost;
- design transient participant/judge/audience interfaces mobile-first;
- prevent dangerous actions rather than relying on warnings alone.

Studio may be powerful.

Live must be fast and obvious.

Portal must be minimal.

Ops must make missing work visible.

---

# 22. Extensibility

ArtFlow grows primarily by adding or evolving Capabilities.

A new capability must be able to declare:

- its identity and version;
- dependencies;
- conflicts;
- definition contract;
- commands;
- queries;
- events;
- permissions;
- product-surface contributions;
- migration requirements.

Core extension points must be explicit.

ArtFlow should avoid arbitrary internal hooks that allow one module to mutate any other module.

Trusted first-party capabilities may run within the modular application.

Untrusted third-party executable code, if supported in the future, must not receive unrestricted access to the primary application process or authoritative data.

---

# 23. Engineering Architecture

ArtFlow-Plus is designed as a **modular monolith first**.

Modularity describes business ownership and code boundaries.

It does not require microservices.

The system should retain:

- one coherent deployment for ordinary installations;
- explicit domain boundaries;
- transactional authority;
- independently testable domain logic;
- replaceable infrastructure adapters.

Individual components may later be separated only when a demonstrated scaling, isolation, security, or operational reason exists.

Complex distributed infrastructure is not a product goal.

---

# 24. Reliability Principles

ArtFlow must be designed for real events rather than ideal networks.

It therefore requires:

- explicit authority boundaries;
- concurrency protection;
- idempotent critical commands;
- immutable formal releases;
- deterministic calculations;
- graceful realtime degradation;
- safe retries;
- auditable recovery;
- backup and restore;
- controlled media access;
- deployment version consistency;
- clear health diagnostics.

Correctness takes priority over realtime appearance.

Recoverability takes priority over pretending failures never happen.

---

# 25. Testing Philosophy

Historical implementation is evidence, not specification.

ArtFlow v1 provides:

- proven behavior;
- historical data;
- bug cases;
- incident knowledge;
- regression fixtures.

ArtFlow-Plus derives durable contracts from that evidence.

Important guarantees should have multiple forms of evidence as appropriate:

- domain unit tests;
- counterexample tests;
- property-based tests;
- implementation-independent Golden fixtures;
- contract tests;
- real database concurrency tests;
- key user-journey E2E tests;
- deployment and restore tests.

A historical bug should become a durable test or invariant whenever possible.

---

# 26. ArtFlow v1 Relationship

ArtFlow v1.0.0 is the first production reference implementation.

It is not the architecture ArtFlow-Plus must preserve.

ArtFlow-Plus preserves:

- verified business semantics;
- validated user workflows;
- domain invariants;
- historical edge cases;
- incident knowledge.

It does not preserve obsolete implementation structure merely for compatibility.

Migration proceeds incrementally by vertical slice.

At any transition boundary, only one implementation may be authoritative for the same business fact.

---

# 27. Initial Capability Coverage

ArtFlow-Plus should eventually support both competitions and broader event operations.

Its architecture must be demonstrated against structurally different activities.

At minimum, the core model should successfully express:

### A judged singing competition

Including registration, materials, judges, scoring, advancement, audience voting, confirmation and publication.

### A stage show

Including program collection, review, materials, scheduling, rehearsals, staff work, resources and live execution.

### A structurally different competition or complex activity

Used to demonstrate that the architecture has not merely generalized two known examples.

If supporting the third case requires rewriting the Activity kernel, Capability model, or authority model, the abstraction is not yet sufficiently general.

---

# 28. Explicit Non-Goals

ArtFlow is not intended to become:

- a general ERP;
- a general CRM;
- a general chat platform;
- a general cloud storage product;
- an unrestricted low-code programming platform;
- a generic spreadsheet/database replacement;
- a stage lighting or audio-control system;
- a PowerPoint/media playback controller;
- an arbitrary script-hosting environment;
- a mandatory microservice platform.

ArtFlow integrates with adjacent systems where appropriate instead of replacing all of them.

---

# 29. Success Criteria

ArtFlow-Plus is successful when:

1. structurally different competitions and events can use the same Activity and Capability architecture without rewriting the kernel;
2. organizers can begin from an Activity Pack and customize it without programming;
3. advanced organizers can express substantial variation without forking source code;
4. Studio, Ops, Live and Portal expose the same underlying business truth;
5. formal rules and outcomes are versioned, deterministic, auditable and recoverable;
6. realtime or optional infrastructure failures do not corrupt authoritative operations;
7. test/rehearsal facts cannot contaminate formal facts;
8. adding a capability does not require modifying unrelated capability internals;
9. historical snapshots remain explainable after later configuration changes;
10. important v1 incidents are structurally prevented or permanently covered by regression evidence;
11. the system remains deployable and operable without introducing infrastructure disproportionate to its actual workload;
12. users can understand what is happening, what is blocked, why it is blocked, and how to proceed.

---

# 30. Evolution Rule

This GOAL defines ArtFlow's durable product and architectural identity.

Changes to:

- product surfaces;
- Activity semantics;
- Capability semantics;
- authority model;
- Definition / Release semantics;
- Fact / Decision / Snapshot semantics;
- extensibility philosophy;

require explicit reconsideration of this document.

Changes to:

- framework;
- ORM;
- UI library;
- worker implementation;
- realtime protocol;
- storage provider;
- deployment tooling;

should normally be handled through ADRs without changing the GOAL.

The system should therefore be able to modernize its technology without changing what ArtFlow fundamentally is.

---

# Final Definition

**ArtFlow-Plus is a composable platform for designing, preparing, executing, and participating in competitions and complex events.**

**Studio designs the event.  
Ops turns the plan into operational reality.  
Live runs the event.  
Portal connects everyone outside the organizing core.**

**Engine keeps the rules and authoritative facts consistent.  
Capabilities provide reusable business abilities.  
Activity Packs turn those abilities into practical starting points.**

ArtFlow should be powerful enough to support substantially different events without forcing organizers to build software, and strict enough that customization cannot silently destroy the correctness of a formal event.