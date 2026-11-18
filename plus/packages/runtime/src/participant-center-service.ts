import { createHash } from "node:crypto";

import type { Database, StoredMaterial, StoredRegistration } from "@artflow-plus/db";
import {
  getActivityPublicProfile,
  listMaterials,
  listNotificationReadKeys,
  listRegistrationsByParticipant,
  markNotificationKeysRead,
  selectActiveScheduleRelease,
  selectPublicResults,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { getPublicActivity } from "./registration-read-service.js";

export interface MyNotification {
  readonly key: string;
  readonly kind: "registration" | "material" | "announcement" | "schedule" | "result";
  readonly title: string;
  readonly body: string;
  readonly activity: { readonly publicCode: string; readonly title: string };
  readonly createdAt: string;
  readonly read: boolean;
  readonly href: string;
}

export interface MyEvent {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "draft" | "active" | "closed" | "archived";
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly venue: string;
    readonly organizer: string;
  };
  readonly registration: {
    readonly status: StoredRegistration["status"];
    readonly editable: boolean;
    readonly reviewNote?: string;
    readonly supplementKeys: readonly string[];
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly materials: readonly {
    readonly id: string;
    readonly questionKey: string;
    readonly originalName: string;
    readonly contentType: string;
    readonly byteLength: number;
    readonly status: StoredMaterial["status"];
    readonly reviewNote: string;
    readonly revision: number;
    readonly contentPath: string | null;
    readonly reviewedAt: string | null;
    readonly updatedAt: string | null;
  }[];
  readonly schedule: readonly {
    readonly order: number;
    readonly slotLabel: string;
    readonly title: string;
    readonly note: string;
    readonly startsAt: string | null;
  }[];
  readonly results: readonly {
    readonly stageKey: string;
    readonly publicTitle: string;
    readonly releasedAt: string;
    readonly rank: number;
    readonly score: string;
    readonly unit?: "score" | "percent";
    readonly awards: readonly string[];
  }[];
  readonly links: { readonly event: string | null; readonly edit: string | null };
  readonly archived: boolean;
}

export interface MyCenter {
  readonly events: readonly MyEvent[];
  readonly notifications: {
    readonly items: readonly MyNotification[];
    readonly unreadCount: number;
  };
}

function noteHash(note: string): string {
  return createHash("sha256").update(note).digest("hex").slice(0, 12);
}

function registrationKey(publicCode: string, registration: StoredRegistration): string {
  if (
    registration.status === "need_supplement" ||
    registration.status === "approved" ||
    registration.status === "rejected"
  ) {
    return `${publicCode}:registration:${registration.status}:${registration.reviewedBy ?? "system"}:${noteHash(registration.reviewNote ?? "")}`;
  }
  return `${publicCode}:registration:${registration.status}:${registration.revision}`;
}

function registrationCopy(registration: StoredRegistration): { title: string; body: string } {
  switch (registration.status) {
    case "submitted":
      return { title: "报名已提交", body: "主办方会尽快审核。" };
    case "need_supplement":
      return { title: "报名需要补交", body: registration.reviewNote || "请在报名页补充材料后重新提交。" };
    case "approved":
      return { title: "报名已通过", body: "你的报名已通过审核。" };
    case "rejected":
      return { title: "报名未通过", body: registration.reviewNote || "如有疑问，请联系主办方。" };
    case "withdrawn":
      return { title: "报名已撤回", body: "该报名已撤回。" };
    default:
      return { title: "报名状态更新", body: "" };
  }
}

function eventHref(publicCode: string): string {
  return `/me/${encodeURIComponent(publicCode)}`;
}

export async function getParticipantCenter(
  db: Kysely<Database>,
  deps: RuntimeDeps,
): Promise<MyCenter> {
  const actorId = runtimeActor(deps).actorId;
  const records = await listRegistrationsByParticipant(db, actorId);
  const notifications: MyNotification[] = [];
  const events = await Promise.all(records.map(async (record) => {
    const { registration, activity } = record;
    const [profile, publicActivity, materials, schedule, results] = await Promise.all([
      getActivityPublicProfile(db, activity.id),
      getPublicActivity(db, activity.publicCode),
      listMaterials(db, registration.id),
      selectActiveScheduleRelease(db, activity.publicCode),
      selectPublicResults(db, activity.publicCode),
    ]);
    const archived = activity.status === "archived";
    const editable = publicActivity?.registrationOpen === true &&
      (registration.status === "draft" || registration.status === "need_supplement");
    const mySchedule = schedule === null
      ? []
      : schedule.release.snapshot.entries
        .filter((entry) => entry.participantId === actorId)
        .map((entry) => ({
          order: entry.order,
          slotLabel: entry.slotLabel,
          title: entry.title,
          note: entry.note,
          startsAt: entry.startsAt ?? null,
        }));
    const myResults = results === null
      ? []
      : results.results.flatMap((release) => {
        const decision = release.decisions.find((item) => item.contestantId === actorId);
        const awards = release.awards
          .filter((item) => item.contestantId === actorId)
          .map((item) => item.award);
        if (decision === undefined && awards.length === 0) return [];
        return [{
          stageKey: release.stageKey,
          publicTitle: release.publicTitle,
          releasedAt: release.releasedAt,
          rank: decision?.rank ?? 0,
          score: decision?.score ?? "",
          ...(decision?.unit === undefined ? {} : { unit: decision.unit }),
          awards,
        }];
      });
    const event: MyEvent = {
      activity: {
        publicCode: activity.publicCode,
        title: activity.title,
        status: activity.status as MyEvent["activity"]["status"],
        startsAt: profile.startsAt,
        endsAt: profile.endsAt,
        venue: profile.venue,
        organizer: profile.organizer,
      },
      registration: {
        status: registration.status,
        editable,
        ...(registration.reviewNote === undefined ? {} : { reviewNote: registration.reviewNote }),
        supplementKeys: registration.supplementKeys ?? [],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      materials: materials.map((material) => ({
        id: material.id,
        questionKey: material.questionKey,
        originalName: material.originalName,
        contentType: material.contentType,
        byteLength: material.byteLength,
        status: material.status,
        reviewNote: material.reviewNote,
        revision: material.revision,
        contentPath: material.ownerActorId === actorId
          ? `/api/activities/${encodeURIComponent(activity.id)}/materials/${encodeURIComponent(material.id)}/content`
          : null,
        reviewedAt: material.reviewedAt,
        updatedAt: material.updatedAt ?? null,
      })),
      schedule: mySchedule,
      results: myResults,
      links: {
        event: activity.status === "active" || activity.status === "closed"
          ? `/e/${encodeURIComponent(activity.publicCode)}`
          : null,
        edit: editable ? `/join/${encodeURIComponent(activity.publicCode)}` : null,
      },
      archived,
    };

    const copy = registrationCopy(registration);
    if (registration.status !== "draft") {
      notifications.push({
        key: registrationKey(activity.publicCode, registration),
        kind: "registration",
        title: copy.title,
        body: copy.body,
        activity: { publicCode: activity.publicCode, title: activity.title },
        createdAt: record.updatedAt,
        read: false,
        href: eventHref(activity.publicCode),
      });
    }
    for (const material of materials) {
      if (material.status !== "approved" && material.status !== "needs_supplement") continue;
      notifications.push({
        key: `${activity.publicCode}:material:${material.id}:${material.status}:${material.revision}`,
        kind: "material",
        title: material.status === "approved" ? "材料已通过" : "材料需要补交",
        body: `${material.originalName}${material.reviewNote ? `：${material.reviewNote}` : ""}`,
        activity: { publicCode: activity.publicCode, title: activity.title },
        createdAt: material.reviewedAt ?? material.updatedAt ?? record.updatedAt,
        read: false,
        href: eventHref(activity.publicCode),
      });
    }
    if (!archived && activity.status !== "draft" && profile.announcement.trim() !== "") {
      notifications.push({
        key: `${activity.publicCode}:announcement:${createHash("sha256").update(profile.announcement).digest("hex").slice(0, 16)}`,
        kind: "announcement",
        title: "活动公告",
        body: profile.announcement,
        activity: { publicCode: activity.publicCode, title: activity.title },
        createdAt: profile.updatedAt,
        read: false,
        href: eventHref(activity.publicCode),
      });
    }
    if (schedule !== null && mySchedule.length > 0) {
      notifications.push({
        key: `${activity.publicCode}:schedule:${schedule.release.id}`,
        kind: "schedule",
        title: "节目单已发布",
        body: "你的节目单条目已发布。",
        activity: { publicCode: activity.publicCode, title: activity.title },
        createdAt: schedule.release.releasedAt,
        read: false,
        href: eventHref(activity.publicCode),
      });
    }
    if (results !== null) {
      for (const release of results.results) {
        const decision = release.decisions.find((item) => item.contestantId === actorId);
        const awards = release.awards
          .filter((item) => item.contestantId === actorId)
          .map((item) => item.award);
        if (decision === undefined && awards.length === 0) continue;
        notifications.push({
          key: `${activity.publicCode}:result:${release.releaseId}`,
          kind: "result",
          title: "赛果已发布",
          body: `${decision === undefined ? "" : `第 ${decision.rank} 名`}${awards.length > 0 ? ` · ${awards.join(" / ")}` : ""}`,
          activity: { publicCode: activity.publicCode, title: activity.title },
          createdAt: release.releasedAt,
          read: false,
          href: eventHref(activity.publicCode),
        });
      }
    }
    return event;
  }));

  const keys = notifications.map((item) => item.key);
  const readKeys = await listNotificationReadKeys(db, actorId, keys);
  const items = notifications
    .map((item) => ({ ...item, read: readKeys.has(item.key) }))
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.key.localeCompare(right.key),
    );
  return {
    events,
    notifications: { items, unreadCount: items.filter((item) => !item.read).length },
  };
}

export async function markParticipantNotificationsRead(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  keys: readonly string[],
): Promise<{ readonly unreadCount: number }> {
  const actorId = runtimeActor(deps).actorId;
  const center = await getParticipantCenter(db, deps);
  const allowed = new Set(center.notifications.items.map((item) => item.key));
  const unique = [...new Set(keys)].filter((key) => allowed.has(key));
  await markNotificationKeysRead(db, actorId, unique);
  const marked = new Set(unique);
  return {
    unreadCount: center.notifications.items
      .filter((item) => !item.read && !marked.has(item.key))
      .length,
  };
}
