import type { Database, StoredRelease, StoredResourceBooking } from "@artflow-plus/db";
import {
  cancelResourceBooking as cancelBookingRow,
  confirmResourceBooking as confirmBookingRow,
  findConfirmedResourceOverlap,
  getActivityForUpdate,
  getActivitySummary,
  getRelease,
  getResourceBookingForUpdate,
  insertResourceBooking,
  listResourceBookings,
  lockResource,
  updateResourceBooking as updateBookingRow,
} from "@artflow-plus/db";
import {
  DomainError,
  hasPermission,
  requirePermission,
  type CompiledResourcesArtifact,
  type ResourceDefinition,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";

const READ_PERMISSIONS = ["resources.manage", "studio.manage", "schedule.manage"];

function resourcesArtifact(release: StoredRelease): CompiledResourcesArtifact {
  const plan = release.capabilities.resources;
  if (plan === undefined || plan.ok !== true) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The release has no resources snapshot.");
  }
  const artifact = plan.artifact;
  if (
    typeof artifact !== "object" || artifact === null ||
    (artifact as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((artifact as { resources?: unknown }).resources)
  ) {
    throw new DomainError("RELEASE_SNAPSHOT_INCOMPLETE", "The resources release snapshot is invalid.");
  }
  return artifact as CompiledResourcesArtifact;
}

function requireResourcesEnabled(activity: { readonly enabledCapabilities: readonly string[] }): void {
  if (!activity.enabledCapabilities.includes("resources")) {
    throw new DomainError("CAPABILITY_DISABLED", "The resources capability is not enabled.");
  }
}

async function currentResources(
  trx: Kysely<Database>,
  activity: { readonly id: string; readonly activeDefinitionVersion: number; readonly enabledCapabilities: readonly string[] },
): Promise<{ readonly release: StoredRelease; readonly artifact: CompiledResourcesArtifact }> {
  requireResourcesEnabled(activity);
  const release = await getRelease(trx, activity.id, activity.activeDefinitionVersion);
  if (release === null) throw new DomainError("VERSION_NOT_RELEASED", "The activity has no active released definition.");
  return { release, artifact: resourcesArtifact(release) };
}

function requireRead(actor: ReturnType<typeof runtimeActor>): void {
  if (!READ_PERMISSIONS.some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", "A resources, studio or schedule permission is required.");
  }
}

function resourceFor(artifact: CompiledResourcesArtifact, key: string): ResourceDefinition {
  const resource = artifact.resources.find((item) => item.key === key);
  if (resource === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "The resource is not in the active release.");
  return resource;
}

function normalizeWindow(startsAt: string, endsAt: string): { startsAt: string; endsAt: string } {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new DomainError("INVALID_INPUT", "The booking must end after it starts.");
  }
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
}

function normalizeTitle(value: string): string {
  const title = value.trim();
  if (title === "" || title.length > 200) throw new DomainError("INVALID_INPUT", "Booking title must be 1-200 characters.");
  return title;
}

function normalizeNote(value: string | undefined): string {
  const note = (value ?? "").trim();
  if (note.length > 2000) throw new DomainError("INVALID_INPUT", "Booking note must be at most 2000 characters.");
  return note;
}

export interface ResourcesView {
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly resources: readonly ResourceDefinition[];
  readonly bookings: readonly StoredResourceBooking[];
}

export async function getResourcesView(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<ResourcesView> {
  requireRead(runtimeActor(deps));
  const activity = await getActivitySummary(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const { artifact } = await currentResources(db, activity);
  return {
    activityId,
    definitionVersion: activity.activeDefinitionVersion,
    resources: artifact.resources,
    bookings: await listResourceBookings(db, activityId),
  };
}

export interface CreateBookingInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly resourceKey: string;
  readonly title: string;
  readonly note?: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export async function createResourceBooking(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CreateBookingInput,
): Promise<CommandOutcome<StoredResourceBooking>> {
  const actor = runtimeActor(deps);
  const window = normalizeWindow(input.startsAt, input.endsAt);
  const title = normalizeTitle(input.title);
  const note = normalizeNote(input.note);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "resources",
    commandType: "resources.booking.create",
    actor,
    payload: { resourceKey: input.resourceKey, ...window, title, note },
  }, async (trx) => {
    requirePermission(actor, "resources.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    const { artifact } = await currentResources(trx, activity);
    const resource = resourceFor(artifact, input.resourceKey);
    const id = idFromCommand("booking", input.commandId);
    await insertResourceBooking(trx, {
      id,
      activityId: input.activityId,
      resourceKey: resource.key,
      resourceName: resource.name,
      title,
      note,
      ...window,
      createdBy: actor.actorId,
    });
    const booking = await getResourceBookingForUpdate(trx, id);
    if (booking === null) throw new DomainError("NOT_FOUND", "The booking was not created.");
    await appendEngineEvent(trx, deps, {
      type: "ResourceBookingCreated",
      activityId: input.activityId,
      aggregateType: "resource_booking",
      aggregateId: id,
      revision: booking.revision,
      capability: "resources",
      payload: { bookingId: id, resourceKey: resource.key, ...window },
    });
    return { body: booking, status: 201 };
  });
}

export interface UpdateBookingInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly bookingId: string;
  readonly title?: string;
  readonly note?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly expectedRevision: number;
}

export async function updateResourceBooking(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UpdateBookingInput,
): Promise<CommandOutcome<StoredResourceBooking>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "resources",
    commandType: "resources.booking.update",
    actor,
    payload: {
      bookingId: input.bookingId,
      expectedRevision: input.expectedRevision,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
      ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
    },
  }, async (trx) => {
    requirePermission(actor, "resources.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    await currentResources(trx, activity);
    const booking = await getResourceBookingForUpdate(trx, input.bookingId);
    if (booking === null || booking.activityId !== input.activityId) throw new DomainError("NOT_FOUND", "The booking was not found.");
    if (booking.status === "cancelled") throw new DomainError("BOOKING_CANCELLED", "Cancelled bookings are read-only.");
    if (booking.revision !== input.expectedRevision) throw new DomainError("STALE_REVISION", "The booking changed since it was read.");
    const window = normalizeWindow(input.startsAt ?? booking.startsAt, input.endsAt ?? booking.endsAt);
    const title = input.title === undefined ? booking.title : normalizeTitle(input.title);
    const note = input.note === undefined ? booking.note : normalizeNote(input.note);
    if (booking.status === "confirmed") {
      await lockResource(trx, input.activityId, booking.resourceKey);
      const overlap = await findConfirmedResourceOverlap(trx, {
        activityId: input.activityId,
        resourceKey: booking.resourceKey,
        ...window,
        excludeId: booking.id,
      });
      if (overlap !== null) throw new DomainError("RESOURCE_CONFLICT", "The resource is already booked for this window.");
    }
    const updated = await updateBookingRow(trx, booking.id, input.expectedRevision, { title, note, ...window });
    if (!updated) throw new DomainError("STALE_REVISION", "The booking changed since it was read.");
    const saved = await getResourceBookingForUpdate(trx, booking.id);
    if (saved === null) throw new DomainError("NOT_FOUND", "The booking was not found.");
    await appendEngineEvent(trx, deps, {
      type: "ResourceBookingUpdated",
      activityId: input.activityId,
      aggregateType: "resource_booking",
      aggregateId: booking.id,
      revision: saved.revision,
      capability: "resources",
      payload: { bookingId: booking.id, resourceKey: booking.resourceKey, ...window },
    });
    return { body: saved };
  });
}

export async function confirmResourceBookingCommand(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly commandId: string; readonly activityId: string; readonly bookingId: string; readonly expectedRevision: number },
): Promise<CommandOutcome<StoredResourceBooking>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "resources",
    commandType: "resources.booking.confirm",
    actor,
    payload: { bookingId: input.bookingId, expectedRevision: input.expectedRevision },
  }, async (trx) => {
    requirePermission(actor, "resources.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    await currentResources(trx, activity);
    const booking = await getResourceBookingForUpdate(trx, input.bookingId);
    if (booking === null || booking.activityId !== input.activityId) throw new DomainError("NOT_FOUND", "The booking was not found.");
    if (booking.status !== "draft") throw new DomainError("INVALID_TRANSITION", "Only draft bookings can be confirmed.");
    if (booking.revision !== input.expectedRevision) throw new DomainError("STALE_REVISION", "The booking changed since it was read.");
    await lockResource(trx, input.activityId, booking.resourceKey);
    const overlap = await findConfirmedResourceOverlap(trx, {
      activityId: input.activityId,
      resourceKey: booking.resourceKey,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      excludeId: booking.id,
    });
    if (overlap !== null) throw new DomainError("RESOURCE_CONFLICT", "The resource is already booked for this window.");
    const confirmed = await confirmBookingRow(trx, booking.id, input.expectedRevision);
    if (!confirmed) throw new DomainError("STALE_REVISION", "The booking changed since it was read.");
    const saved = await getResourceBookingForUpdate(trx, booking.id);
    if (saved === null) throw new DomainError("NOT_FOUND", "The booking was not found.");
    await appendEngineEvent(trx, deps, {
      type: "ResourceBookingConfirmed",
      activityId: input.activityId,
      aggregateType: "resource_booking",
      aggregateId: booking.id,
      revision: saved.revision,
      capability: "resources",
      payload: { bookingId: booking.id, resourceKey: booking.resourceKey },
    });
    return { body: saved };
  });
}

export async function cancelResourceBookingCommand(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly commandId: string; readonly activityId: string; readonly bookingId: string; readonly expectedRevision: number; readonly reason: string },
): Promise<CommandOutcome<StoredResourceBooking>> {
  const actor = runtimeActor(deps);
  const reason = input.reason.trim();
  if (reason === "") throw new DomainError("INVALID_INPUT", "A cancellation reason is required.");
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "resources",
    commandType: "resources.booking.cancel",
    actor,
    payload: { bookingId: input.bookingId, expectedRevision: input.expectedRevision, reason },
  }, async (trx) => {
    requirePermission(actor, "resources.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    await currentResources(trx, activity);
    const booking = await getResourceBookingForUpdate(trx, input.bookingId);
    if (booking === null || booking.activityId !== input.activityId) throw new DomainError("NOT_FOUND", "The booking was not found.");
    if (booking.status === "cancelled") throw new DomainError("BOOKING_CANCELLED", "The booking is already cancelled.");
    if (booking.revision !== input.expectedRevision) throw new DomainError("STALE_REVISION", "The booking changed since it was read.");
    const cancelled = await cancelBookingRow(trx, booking.id, input.expectedRevision, new Date(deps.now()), reason);
    if (!cancelled) throw new DomainError("STALE_REVISION", "The booking changed since it was read.");
    const saved = await getResourceBookingForUpdate(trx, booking.id);
    if (saved === null) throw new DomainError("NOT_FOUND", "The booking was not found.");
    await appendEngineEvent(trx, deps, {
      type: "ResourceBookingCancelled",
      activityId: input.activityId,
      aggregateType: "resource_booking",
      aggregateId: booking.id,
      revision: saved.revision,
      capability: "resources",
      payload: { bookingId: booking.id, resourceKey: booking.resourceKey, reason },
    });
    return { body: saved };
  });
}
