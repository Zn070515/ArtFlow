import { randomUUID } from "node:crypto";

import type { Database } from "@artflow-plus/db";
import { getActivitySummary, insertAudit } from "@artflow-plus/db";
import { DomainError, hasPermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { getPublicEventSite, type PublicEventSite } from "./public-event-service.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface WechatArticleContext {
  readonly activityTitle: string;
  readonly publicCode: string;
  readonly site: PublicEventSite;
}

function section(title: string, body: string): string {
  return `<section style="margin:24px 0;"><h2 style="font-size:20px;font-weight:600;color:#1a1a1a;margin:0 0 12px;">${escapeHtml(title)}</h2>${body}</section>`;
}

function paragraph(value: string): string {
  return `<p style="font-size:15px;line-height:1.8;color:#333;margin:0 0 10px;">${escapeHtml(value)}</p>`;
}

/** Inline-only HTML: WeChat's editor strips external stylesheets and classes. */
export async function buildWechatArticle(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
  appBaseUrl: string,
): Promise<{ readonly html: string; readonly filename: string }> {
  const actor = runtimeActor(deps);
  if (!["result.manage", "publishing.manage", "studio.manage", "archive.manage"].some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", "A result or studio permission is required.");
  }
  const activity = await getActivitySummary(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const site = await getPublicEventSite(db, activity.publicCode);
  if (site === null) throw new DomainError("NOT_FOUND", "The public event was not found.");
  const hasResults = site.results !== null && site.results.results.length > 0;
  const hasSchedule = (site.schedule?.entries.length ?? 0) > 0 || (site.program?.entries.length ?? 0) > 0;
  if (!hasResults && !hasSchedule) {
    throw new DomainError("WECHAT_ARTICLE_EMPTY", "Publish a schedule or confirmed result before generating the article.");
  }
  const base = appBaseUrl.replace(/\/+$/, "");
  const publicUrl = `${base}/e/${encodeURIComponent(activity.publicCode)}`;
  const html = renderWechatArticle({
    activityTitle: activity.title,
    publicCode: activity.publicCode,
    site,
  }, publicUrl);
  await db.transaction().execute(async (trx) => {
    await insertAudit(trx, {
      commandId: `wechat-${randomUUID()}`,
      activityId,
      capability: "export",
      commandType: "export.wechat_article",
      actor,
      detail: { publicCode: activity.publicCode, hasResults, hasSchedule },
    });
  });
  return { html, filename: `wechat-${activity.publicCode}.html` };
}

export function renderWechatArticle(input: WechatArticleContext, publicUrl: string): string {
  const { site } = input;
  const parts: string[] = [];
  parts.push(`<section style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;padding:8px 4px;">`);
  parts.push(`<h1 style="font-size:26px;line-height:1.3;font-weight:700;margin:0 0 8px;">${escapeHtml(input.activityTitle)}</h1>`);
  if (site.profile.tagline.trim() !== "") parts.push(paragraph(site.profile.tagline));
  const meta = [site.profile.venue, site.profile.startsAt, site.profile.organizer].filter((value) => value !== null && value !== "").join(" · ");
  if (meta !== "") parts.push(`<p style="font-size:13px;color:#888;margin:0 0 20px;">${escapeHtml(meta)}</p>`);

  if (site.profile.description.trim() !== "") {
    parts.push(section("活动介绍", paragraph(site.profile.description)));
  }

  if (site.results !== null && site.results.results.length > 0) {
    const resultBlocks = site.results.results.map((result) => {
      const rows = result.decisions.map((decision) => (
        `<p style="font-size:15px;line-height:1.9;margin:0;">${decision.rank}. ${escapeHtml(decision.contestantName)}　${escapeHtml(decision.unit === "percent" ? `${decision.score}%` : decision.score)}</p>`
      )).join("");
      const awards = result.awards.length === 0
        ? ""
        : `<p style="font-size:14px;line-height:1.8;color:#8a6a2a;margin:8px 0 0;">${result.awards.map((award) => `${escapeHtml(award.award)}：${escapeHtml(award.contestantName)}`).join("　")}</p>`;
      return `<section style="margin:0 0 18px;"><h3 style="font-size:17px;margin:0 0 6px;">${escapeHtml(result.publicTitle)}</h3>${rows}${awards}</section>`;
    }).join("");
    parts.push(section("正式赛果", resultBlocks));
  }

  const schedule = site.schedule?.entries ?? [];
  if (schedule.length > 0) {
    parts.push(section("节目单", schedule.map((entry) => (
      `<p style="font-size:15px;line-height:1.8;margin:0;">${escapeHtml(entry.slotLabel)}　${escapeHtml(entry.title)}${entry.note === "" ? "" : `　<span style="color:#888;">${escapeHtml(entry.note)}</span>`}</p>`
    )).join("")));
  } else if (site.program !== null && site.program.entries.length > 0) {
    parts.push(section("节目单", site.program.entries.map((entry) => (
      `<p style="font-size:15px;line-height:1.8;margin:0;">${entry.order}. ${escapeHtml(entry.name)}${entry.song === "" ? "" : `　${escapeHtml(entry.song)}`}</p>`
    )).join("")));
  }

  if (site.profile.announcement.trim() !== "") {
    parts.push(section("公告", paragraph(site.profile.announcement)));
  }

  parts.push(`<p style="font-size:13px;color:#888;margin:24px 0 0;">查看完整活动：${escapeHtml(publicUrl)}</p>`);
  parts.push("</section>");
  return parts.join("");
}
