import { createHash } from "node:crypto";

import type { Database } from "@artflow-plus/db";
import {
  advanceNotificationCursor,
  getNotificationCursorState,
  getOutboxHead,
  getRegistrationRecipient,
  insertNotificationDeliveries,
  listApprovedParticipantRecipients,
  listPendingNotificationDeliveries,
  markNotificationFailed,
  markNotificationSent,
  readOutboxAfter,
  type NewNotificationDelivery,
  type NotificationRecipient,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

import type { Mailer } from "./mail-service.js";

const CHANNEL = "email";
const MAX_EVENTS_PER_PASS = 100;
const MAX_RECIPIENTS_PER_EVENT = 500;

export function emailNotificationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARTFLOW_PLUS_EMAIL_NOTIFICATIONS === "1";
}

function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ARTFLOW_PLUS_APP_BASE_URL ?? "http://127.0.0.1:4173").replace(/\/+$/, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function deliveryId(eventId: string, recipient: string): string {
  return `${eventId}:email:${createHash("sha256").update(recipient).digest("hex").slice(0, 24)}`;
}

function registrationId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as { registrationId?: unknown }).registrationId;
  return typeof value === "string" && value !== "" ? value : null;
}

function reviewDecision(payload: unknown): { status: string; note: string } {
  const record = payload !== null && typeof payload === "object"
    ? payload as { status?: unknown; note?: unknown }
    : {};
  return {
    status: typeof record.status === "string" ? record.status : "reviewed",
    note: typeof record.note === "string" ? record.note : "",
  };
}

function render(
  kind: string,
  recipient: NotificationRecipient,
  payload: unknown,
): NewNotificationDelivery {
  const base = appBaseUrl();
  const title = recipient.activityTitle || recipient.publicCode;
  const meLink = `${base}/me/${encodeURIComponent(recipient.publicCode)}`;
  const programLink = `${base}/program/${encodeURIComponent(recipient.publicCode)}`;
  const resultLink = `${base}/results/${encodeURIComponent(recipient.publicCode)}`;
  let subject: string;
  let text: string;
  let link: string;
  if (kind === "registration_submitted") {
    subject = `已收到你的报名：${title}`;
    text = `你的报名已提交。可以在 ArtFlow 个人中心查看审核状态和材料要求。`;
    link = meLink;
  } else if (kind === "registration_reviewed") {
    const decision = reviewDecision(payload);
    const label = decision.status === "approved"
      ? "已通过"
      : decision.status === "needs_supplement"
        ? "需要补充材料"
        : decision.status === "rejected"
          ? "未通过"
          : "已更新";
    subject = `报名审核结果：${title}`;
    text = `你的报名状态：${label}。${decision.note === "" ? "" : `\n审核意见：${decision.note}`}`;
    link = meLink;
  } else if (kind === "schedule_released") {
    subject = `节目单已发布：${title}`;
    text = "最新节目单已发布，可以在公开活动页查看。";
    link = programLink;
  } else {
    subject = `正式赛果已发布：${title}`;
    text = "正式赛果已发布，可以在公开结果页查看。";
    link = resultLink;
  }
  const body = `${text}\n\n${link}`;
  const html = `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p><p><a href="${escapeHtml(link)}">打开 ArtFlow</a></p>`;
  return {
    id: deliveryId("pending", recipient.email),
    eventId: "pending",
    channel: CHANNEL,
    recipient: recipient.email,
    kind,
    subject,
    body,
    link,
  };
}

async function recipientsFor(
  db: Kysely<Database>,
  event: { readonly type: string; readonly activityId: string; readonly payload: unknown },
): Promise<{ readonly kind: string; readonly recipients: readonly NotificationRecipient[]; readonly payload?: unknown } | null> {
  if (event.type === "RegistrationSubmitted") {
    const id = registrationId(event.payload);
    const recipient = id === null ? null : await getRegistrationRecipient(db, id);
    return recipient === null ? null : { kind: "registration_submitted", recipients: [recipient] };
  }
  if (event.type === "RegistrationReviewed") {
    const id = registrationId(event.payload);
    const recipient = id === null ? null : await getRegistrationRecipient(db, id);
    return recipient === null ? null : { kind: "registration_reviewed", recipients: [recipient], payload: event.payload };
  }
  if (event.type === "ScheduleReleased") {
    return { kind: "schedule_released", recipients: await listApprovedParticipantRecipients(db, event.activityId) };
  }
  if (event.type === "ResultReleased") {
    return { kind: "result_released", recipients: await listApprovedParticipantRecipients(db, event.activityId) };
  }
  return null;
}

export async function enqueueEmailNotifications(
  db: Kysely<Database>,
  options: { readonly limit?: number } = {},
): Promise<{ readonly enqueued: number }> {
  if (!emailNotificationsEnabled()) return { enqueued: 0 };
  const state = await getNotificationCursorState(db, CHANNEL);
  if (state === null) {
    // First enable: start at the head so historical events are not emailed.
    const head = await getOutboxHead(db);
    if (head > 0) await advanceNotificationCursor(db, CHANNEL, head);
    return { enqueued: 0 };
  }
  const cursor = state.lastOutboxId;
  const events = await readOutboxAfter(db, cursor, Math.min(options.limit ?? MAX_EVENTS_PER_PASS, MAX_EVENTS_PER_PASS));
  if (events.length === 0) return { enqueued: 0 };

  const rows: NewNotificationDelivery[] = [];
  for (const event of events) {
    // TEST/REHEARSAL facts must never leave the building as participant email.
    if (event.mode !== undefined && event.mode !== "formal") continue;
    const resolved = await recipientsFor(db, event);
    if (resolved === null) continue;
    const recipients = resolved.recipients.slice(0, MAX_RECIPIENTS_PER_EVENT);
    for (const recipient of recipients) {
      const content = render(resolved.kind, recipient, resolved.payload);
      rows.push({
        ...content,
        id: deliveryId(event.eventId, recipient.email),
        eventId: event.eventId,
      });
    }
  }

  const lastId = events[events.length - 1]?.id ?? cursor;
  await db.transaction().execute(async (trx) => {
    await insertNotificationDeliveries(trx, rows);
    await advanceNotificationCursor(trx, CHANNEL, lastId);
  });
  return { enqueued: rows.length };
}

export async function deliverPendingEmailNotifications(
  db: Kysely<Database>,
  mailer: Mailer | null,
  options: { readonly limit?: number } = {},
): Promise<{ readonly sent: number; readonly failed: number }> {
  if (mailer?.sendNotification === undefined) return { sent: 0, failed: 0 };
  const pending = await listPendingNotificationDeliveries(db, Math.min(options.limit ?? 20, 100));
  let sent = 0;
  let failed = 0;
  for (const delivery of pending) {
    try {
      await mailer.sendNotification({
        to: delivery.recipient,
        subject: delivery.subject,
        text: delivery.body,
        html: `<p>${escapeHtml(delivery.body).replace(/\n/g, "<br>")}</p><p><a href="${escapeHtml(delivery.link)}">打开 ArtFlow</a></p>`,
      });
      await markNotificationSent(db, delivery.id);
      sent += 1;
    } catch (error) {
      await markNotificationFailed(db, delivery.id, error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }
  return { sent, failed };
}
