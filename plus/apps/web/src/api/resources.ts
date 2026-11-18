import { apiFetch } from "./client.js";

export type ResourceKind = "venue" | "equipment" | "staff";

export interface ResourceDefinition {
  readonly key: string;
  readonly name: string;
  readonly kind: ResourceKind;
  readonly capacity?: number;
  readonly notes: string;
}

export type ResourceBookingStatus = "draft" | "confirmed" | "cancelled";

export interface ResourceBooking {
  readonly id: string;
  readonly activityId: string;
  readonly resourceKey: string;
  readonly resourceName: string;
  readonly title: string;
  readonly note: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: ResourceBookingStatus;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
}

export interface ResourcesView {
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly resources: readonly ResourceDefinition[];
  readonly bookings: readonly ResourceBooking[];
}

export function fetchResources(activityId: string): Promise<ResourcesView> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/resources`);
}

export function createBooking(
  activityId: string,
  commandId: string,
  input: {
    readonly resourceKey: string;
    readonly title: string;
    readonly note?: string;
    readonly startsAt: string;
    readonly endsAt: string;
  },
): Promise<ResourceBooking> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/resources/bookings`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify(input),
  });
}

export function updateBooking(
  activityId: string,
  booking: ResourceBooking,
  commandId: string,
  input: {
    readonly title?: string;
    readonly note?: string;
    readonly startsAt?: string;
    readonly endsAt?: string;
  },
): Promise<ResourceBooking> {
  return apiFetch(
    `/api/activities/${encodeURIComponent(activityId)}/resources/bookings/${encodeURIComponent(booking.id)}`,
    {
      method: "PUT",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ ...input, expectedRevision: booking.revision }),
    },
  );
}

export function confirmBooking(activityId: string, booking: ResourceBooking, commandId: string): Promise<ResourceBooking> {
  return apiFetch(
    `/api/activities/${encodeURIComponent(activityId)}/resources/bookings/${encodeURIComponent(booking.id)}/confirm`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision: booking.revision }),
    },
  );
}

export function cancelBooking(
  activityId: string,
  booking: ResourceBooking,
  reason: string,
  commandId: string,
): Promise<ResourceBooking> {
  return apiFetch(
    `/api/activities/${encodeURIComponent(activityId)}/resources/bookings/${encodeURIComponent(booking.id)}/cancel`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision: booking.revision, reason }),
    },
  );
}
