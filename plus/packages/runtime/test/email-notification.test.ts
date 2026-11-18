import { randomUUID } from "node:crypto";

import {
  advanceNotificationCursor,
  appendEvent,
  closeDb,
  createDb,
  insertLocalAccount,
  insertRegistration,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword } from "../src/auth-service.js";
import {
  deliverPendingEmailNotifications,
  enqueueEmailNotifications,
} from "../src/email-notification-service.js";
import type { NotificationMessage } from "../src/mail-service.js";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_email_notification_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
const delivered: NotificationMessage[] = [];

const mailer = {
  async sendPasswordReset() {},
  async sendNotification(message: NotificationMessage) {
    delivered.push(message);
  },
};

async function seed(activityId: string, suffix: string, email?: string): Promise<string> {
  await insertLocalAccount(db, {
    username: `participant-${suffix}`,
    passwordDigest: hashPassword(`password-${suffix}-123`),
    ...(email === undefined ? {} : { email }),
    actor: {
      actorId: `participant:${suffix}`,
      actorType: "user",
      roles: ["participant"],
      permissions: [],
    },
    active: true,
  });
  const registrationId = `reg-${suffix}`;
  await insertRegistration(db, {
    id: registrationId,
    activityId,
    participantId: `participant:${suffix}`,
    questionnaireVersion: "v1",
    questionnaireHash: "hash",
    status: "approved",
    answers: {},
    supplementKeys: [],
    revision: 1,
  });
  return registrationId;
}

async function emit(
  activityId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  await appendEvent(db, {
    eventId: randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    activityId,
    aggregateType: "registration",
    aggregateId: "aggregate",
    capability: "registration",
    revision: 1,
    payload,
  });
}

describe.skipIf(!connectionString)("email notifications", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    process.env.ARTFLOW_PLUS_EMAIL_NOTIFICATIONS = "1";
    process.env.ARTFLOW_PLUS_APP_BASE_URL = "https://artflow.example";
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    const activityId = "act-email";
    await db.insertInto("activity").values({
      id: activityId,
      public_code: "EMAIL-1",
      title: "邮件测试活动",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify([]),
      active_definition_version: 1,
    }).execute();
    const withEmail = await seed(activityId, "with-email", "person@example.com");
    await seed(activityId, "no-email");
    await emit(activityId, "RegistrationSubmitted", { registrationId: withEmail });
    await emit(activityId, "RegistrationReviewed", { registrationId: withEmail, status: "approved", note: "欢迎" });
    await emit(activityId, "ScheduleReleased", {});
    // Mark the channel initialized at 0 so the test can replay its own events.
    await advanceNotificationCursor(db, "email", 0);
  });

  afterAll(async () => {
    if (!connectionString) return;
    delete process.env.ARTFLOW_PLUS_EMAIL_NOTIFICATIONS;
    delete process.env.ARTFLOW_PLUS_APP_BASE_URL;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("enqueues one delivery per event/recipient and skips accounts without email", async () => {
    delivered.length = 0;
    const first = await enqueueEmailNotifications(db);
    expect(first.enqueued).toBe(3);
    const second = await enqueueEmailNotifications(db);
    expect(second.enqueued).toBe(0);
    const result = await deliverPendingEmailNotifications(db, mailer);
    expect(result).toEqual({ sent: 3, failed: 0 });
    expect(delivered).toHaveLength(3);
    expect(delivered.every((message) => message.to === "person@example.com")).toBe(true);
    expect(delivered.map((message) => message.subject)).toEqual(expect.arrayContaining([
      "已收到你的报名：邮件测试活动",
      "报名审核结果：邮件测试活动",
      "节目单已发布：邮件测试活动",
    ]));
    expect(delivered[0]?.text).toContain("https://artflow.example".slice(0, 8));
  });

  it("does nothing when the feature flag is off", async () => {
    process.env.ARTFLOW_PLUS_EMAIL_NOTIFICATIONS = "0";
    expect((await enqueueEmailNotifications(db)).enqueued).toBe(0);
    process.env.ARTFLOW_PLUS_EMAIL_NOTIFICATIONS = "1";
  });
});
