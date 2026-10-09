#!/usr/bin/env node

// Local site load simulation: a mixed cast of real browsers against the running stack.
//
// The plan this implements is docs/local-load-simulation-plan.md. The shape follows the
// existing `media_download_load_rehearsal.mjs`: measurements are numbers, hard checks exit
// non-zero, and the base URL must be a loopback one — this drives a real service, so it must
// not be pointed at anything but a rehearsal stack.
//
//   node scripts/site_load_rehearsal.mjs
//
// Environment:
//   ARTFLOW_LOAD_MANIFEST_PATH      required, written by prepare_site_load_rehearsal
//   ARTFLOW_LOAD_STAFF_ACCESS_KEY   required, the staff access key of the stack under test
//   ARTFLOW_LOAD_ADMIN_ACCESS_KEY   required, likewise
//   ARTFLOW_LOAD_BASE_URL           default http://127.0.0.1:8000
//   ARTFLOW_LOAD_OUTPUT_DIR         default logs/load-sim
//   ARTFLOW_LOAD_SPEED              default 1; >1 compresses the 12-minute timeline so the
//                                   runner itself can be debugged without a 12-minute wait
//   ARTFLOW_LOAD_PHASES             default "all"; a comma list of p1,p2,p2b,p3,p3b
//   ARTFLOW_LOAD_REALTIME_CONTAINER / ARTFLOW_LOAD_REDIS_CONTAINER  default the event stack's

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

// --- configuration ----------------------------------------------------------------------

const manifestPath = process.env.ARTFLOW_LOAD_MANIFEST_PATH;
if (!manifestPath) throw new Error("ARTFLOW_LOAD_MANIFEST_PATH is required.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const staffAccessKey = process.env.ARTFLOW_LOAD_STAFF_ACCESS_KEY;
const adminAccessKey = process.env.ARTFLOW_LOAD_ADMIN_ACCESS_KEY;
if (!staffAccessKey || !adminAccessKey) {
  throw new Error(
    "ARTFLOW_LOAD_STAFF_ACCESS_KEY and ARTFLOW_LOAD_ADMIN_ACCESS_KEY are required. They are " +
      "deliberately not in the manifest: a file holding both a username and its key is a " +
      "ready-to-use credential bundle.",
  );
}

const rawBaseUrl = process.env.ARTFLOW_LOAD_BASE_URL ?? "http://127.0.0.1:8000";
const base = new URL(rawBaseUrl);
if (base.protocol !== "http:" || !new Set(["127.0.0.1", "localhost", "::1"]).has(base.hostname)) {
  throw new Error("This rehearsal only accepts an HTTP service on localhost/127.0.0.1/::1.");
}
const baseUrl = rawBaseUrl.replace(/\/$/, "");
const realtimeContainer = process.env.ARTFLOW_LOAD_REALTIME_CONTAINER ?? "deploy-realtime-1";
const redisContainer = process.env.ARTFLOW_LOAD_REDIS_CONTAINER ?? "deploy-redis-1";

const outputDir = path.resolve(process.env.ARTFLOW_LOAD_OUTPUT_DIR ?? "logs/load-sim");
mkdirSync(outputDir, { recursive: true });
const actorsLogPath = path.join(outputDir, "actors.log");
const reportPath = path.join(outputDir, "report.json");

// The timeline is the plan's, in seconds. SPEED compresses it for debugging only.
const SPEED = Number(process.env.ARTFLOW_LOAD_SPEED ?? 1);
if (!Number.isFinite(SPEED) || SPEED < 1) throw new Error("ARTFLOW_LOAD_SPEED must be >= 1.");
const phases = new Set((process.env.ARTFLOW_LOAD_PHASES ?? "all").split(","));
const runs = (name) => phases.has("all") || phases.has(name);
const at = (seconds) => Math.round((seconds * 1000) / SPEED);

const code = manifest.activity.public_code;
const entryToken = manifest.activity.judge_entry_token;
const startedAt = Date.now();

// --- evidence ---------------------------------------------------------------------------

const httpFailures = [];
const measurements = [];
const timeline = [];
const readySeats = [];

function record(entry) {
  const line = JSON.stringify({ t: ((Date.now() - startedAt) / 1000).toFixed(1), ...entry });
  appendFileSync(actorsLogPath, `${line}\n`);
}
function mark(phase, note = "") {
  timeline.push({ phase, note, t: (Date.now() - startedAt) / 1000 });
  record({ actor: "phase", action: phase, note });
}
function actorPage(context, actor) {
  const page = context.newPage();
  return page.then((resolved) => {
    resolved.on("response", (response) => {
      if (response.status() >= 400) {
        httpFailures.push({ actor, status: response.status(), url: response.url() });
      }
    });
    // The ticket revoke form and a few others confirm() before submitting, and Playwright
    // dismisses dialogs by default — which would silently turn the injection into a no-op.
    resolved.on("dialog", (dialog) => dialog.accept().catch(() => {}));
    return resolved;
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(seconds) {
  const remaining = at(seconds) - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}
function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}
// Debugging the runner should not require building the whole cast first.
function audienceLimit() {
  const limit = Number(process.env.ARTFLOW_LOAD_AUDIENCE_LIMIT ?? 0);
  return Number.isFinite(limit) && limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
}

// --- actors -----------------------------------------------------------------------------

async function loginStaff(page, credentials) {
  await page.goto(`${baseUrl}/login/staff/`);
  await page.getByLabel("用户名").fill(credentials.username);
  await page.getByLabel("密码").fill(credentials.password);
  await page.getByLabel("工作人员密钥").fill(staffAccessKey);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/staff\/$/);
}

async function loginAdmin(page) {
  await page.goto(`${baseUrl}/login/admin/`);
  await page.getByLabel("用户名").fill(manifest.admin.username);
  await page.getByLabel("密码").fill(manifest.admin.password);
  await page.getByLabel("管理员密钥").fill(adminAccessKey);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/staff\/$/);
}

async function seatLabel(page) {
  try {
    return (await page.locator("[data-seat-label]").textContent({ timeout: 2000 })) ?? "";
  } catch {
    return "";
  }
}

/** A judge terminal: scan the capability, then submit whatever score the show asks for. */
async function judgeActor(browser, label, { dropFirstAck = false } = {}) {
  const context = await browser.newContext();
  const page = await actorPage(context, label);
  if (dropFirstAck) {
    let dropped = false;
    await page.route("**/judge/score/", async (route) => {
      const response = await route.fetch();
      if (!dropped) {
        dropped = true;
        await route.abort("failed");
        return;
      }
      await route.fulfill({ response });
    });
  }
  await page.goto(`${baseUrl}/e/${code}/judge/#${entryToken}`);
  // The seat label renders as "—" until a context arrives, so the actor has to wait for the
  // status to settle — ready *or* refused — before reading it. Reading the placeholder counts
  // every terminal as seated, including the one that was turned away.
  const status = page.locator("[data-status]");
  await status
    .filter({ hasText: /就绪|已满|未开放|无效|已暂停|尚未准备/ })
    .waitFor({ timeout: 25000 });
  const text = ((await status.textContent()) ?? "").trim();
  const ready = text.includes("就绪");
  const seat = ready ? (await seatLabel(page)).trim() : "";
  record({ actor: label, action: "claim", seat, ready, status: text.slice(0, 30) });
  if (seat) readySeats.push(seat);
  return { label, context, page, ready };
}

async function submitJudgeScore(actor, score) {
  const { page } = actor;
  const status = page.locator("[data-status]");
  const submit = page.locator("[data-submit]");
  if (!(await submit.isEnabled().catch(() => false))) {
    record({ actor: actor.label, action: "score", skipped: ((await status.textContent()) ?? "").slice(0, 30) });
    return;
  }
  await page.locator("[data-score]").fill(score);
  const before = Date.now();
  await submit.click();
  await status
    .filter({ hasText: /评分已确认|网络暂时不可用|现场暂停|不接受|失败|无效/ })
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  const text = ((await status.textContent()) ?? "").trim();
  measurements.push({ name: "judge_score", ms: Date.now() - before });
  record({ actor: actor.label, action: "score", status: text.slice(0, 40) });
  if (text.includes("网络暂时不可用")) {
    // The ACK-loss path: a retry of the same submission must be safe, not a second fact.
    await sleep(at(1));
    if (await submit.isEnabled().catch(() => false)) await submit.click();
    await status.waitFor({ timeout: 15000 }).catch(() => {});
    record({ actor: actor.label, action: "score_retry", status: ((await status.textContent()) ?? "").slice(0, 40) });
  }
}

/** An audience member: scan the ticket, then watch the live page and vote once. */
async function audienceActor(browser, label, ticket) {
  const context = await browser.newContext();
  const page = await actorPage(context, label);
  let scan = "";
  try {
    await page.goto(`${baseUrl}/tickets/scan/#${encodeURIComponent(ticket.credential)}`);
    // The status element exists before the scan runs, showing "正在读取二维码……". Waiting for
    // the element rather than the *result* reads the placeholder and reports every ticket as
    // unread, which then makes every vote look refused for the wrong reason.
    const settled = page
      .locator("[data-ticket-scan-status]")
      .filter({ hasText: /票据已识别|已完成现场检票|验证失败/ });
    await settled.waitFor({ timeout: 15000 });
    scan = ((await settled.textContent()) ?? "").trim();
  } catch {
    scan = "(scan never settled)";
  }
  record({ actor: label, action: "scan", serial: ticket.serial, status: scan.slice(0, 24) });
  const voted = await castVote(page, label);
  await page.goto(`${baseUrl}/e/${code}/live/`).catch(() => {});
  return { label, context, page, ticket, voted, scan };
}

async function castVote(page, label) {
  const session = manifest.vote_sessions.find((candidate) => candidate.open);
  const before = Date.now();
  try {
    await page.goto(`${baseUrl}/vote/${session.id}/`);
    // A ticket that did not get a session has no ballot form at all, which is the expected
    // answer for the invalid-ticket actors — measured in seconds, not in a 10 s stall each.
    await page.locator("[data-vote-option]").first().waitFor({ timeout: 5000 });
    await page.locator("[data-vote-option]").first().check();
    await page.getByRole("button", { name: "提交投票" }).click();
    await page.getByRole("heading", { name: "投票成功" }).waitFor({ timeout: 8000 });
    measurements.push({ name: "vote_submit", ms: Date.now() - before });
    record({ actor: label, action: "vote", result: "confirmed" });
    return true;
  } catch (error) {
    record({ actor: label, action: "vote", result: "refused", detail: String(error).slice(0, 50) });
    return false;
  }
}

/** A reader: public pages and the live page, no authority of any kind. */
async function readerActor(browser, label, startPath) {
  const context = await browser.newContext();
  const page = await actorPage(context, label);
  await page.goto(`${baseUrl}${startPath}`);
  await page.locator("body").waitFor();
  return { label, context, page };
}

async function pollLive(members, intervalSeconds) {
  for (const group of chunk(members, 25)) {
    await Promise.all(group.map((member) => member.page.reload().catch(() => {})));
  }
  await sleep(at(intervalSeconds));
}

// --- injections -------------------------------------------------------------------------

function docker(...arguments_) {
  try {
    execFileSync("docker", arguments_, { stdio: "pipe" });
    return true;
  } catch (error) {
    record({ actor: "injection", action: "docker", failed: String(error).slice(0, 120) });
    return false;
  }
}

async function probeHealth() {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/healthz/`, { signal: AbortSignal.timeout(5000) });
    return { ms: Date.now() - started, status: response.status };
  } catch (error) {
    return { ms: Date.now() - started, status: 0, detail: String(error).slice(0, 80) };
  }
}

// --- the run ----------------------------------------------------------------------------

const browser = await chromium.launch();
const cast = { judges: [], audience: [], public: [], staff: [] };

async function run() {
  // P1 — cold start, sequentially, so a broken actor is attributable.
  if (runs("p1")) {
    const adminContext = await browser.newContext();
    const adminPage = await actorPage(adminContext, "admin");
    await loginAdmin(adminPage);
    cast.admin = { context: adminContext, page: adminPage };
    record({ actor: "admin", action: "login" });

    for (const credentials of manifest.staff) {
      const context = await browser.newContext();
      const page = await actorPage(context, `staff:${credentials.role}`);
      await loginStaff(page, credentials);
      cast.staff.push({ label: `staff:${credentials.role}`, context, page, credentials });
    }
    record({ actor: "staff", action: "all_logged_in", count: cast.staff.length });

    // The overflow attempt first, so it cannot take a seat a real judge needs.
    const overflow = await judgeActor(browser, "judge:overflow");
    await overflow.context.close();

    for (let index = 0; index < manifest.judge_seats.length; index += 1) {
      cast.judges.push(await judgeActor(browser, `judge:${index + 1}`, { dropFirstAck: index === 1 }));
    }
    record({ actor: "judges", action: "seated", seats: readySeats.slice().sort() });

    const groups = [
      ["audience", manifest.tickets.valid_checked_in],
      ["audience-unchecked", manifest.tickets.valid_not_checked],
      ["audience-revoked", manifest.tickets.revoked],
      ["audience-stale", manifest.tickets.stale_credential],
    ];
    // In batches: 118 actors walking in one at a time takes minutes, and by then the first
    // judge has been idle long enough that the cold start stops resembling a cold start.
    for (const [prefix, tickets] of groups) {
      for (const group of chunk(tickets.slice(0, audienceLimit()), 10)) {
        cast.audience.push(
          ...(await Promise.all(
            group.map((ticket) => audienceActor(browser, `${prefix}:${ticket.serial}`, ticket)),
          )),
        );
      }
    }
    for (const group of chunk([...Array(20).keys()], 10)) {
      cast.public.push(
        ...(await Promise.all(
          group.map((index) => readerActor(browser, `public:${index + 1}`, `/e/${code}/`)),
        )),
      );
    }
    mark("p1", `cast ready: ${cast.judges.length} judges, ${cast.audience.length} audience`);
  }

  // P2 — steady state: judges score, the audience watches.
  if (runs("p2")) {
    const scoring = (async () => {
      let round = 0;
      while (Date.now() - startedAt < at(305)) {
        round += 1;
        for (const judge of cast.judges) await submitJudgeScore(judge, String(85 + (round % 10)));
        await sleep(at(6));
      }
    })();
    const watching = (async () => {
      // The audience's real load is the live page polling, not repeated voting: a ticket
      // votes once, and a rehearsal that keeps re-submitting would measure the refusal path
      // instead of the site.
      while (Date.now() - startedAt < at(305)) {
        await pollLive(cast.audience, 10);
      }
    })();
    const browsing = (async () => {
      while (Date.now() - startedAt < at(305)) {
        for (const group of chunk(cast.public, 10)) {
          await Promise.all(
            group.map((member) =>
              member.page.goto(`${baseUrl}/e/${code}/live/`).catch(() => {}),
            ),
          );
        }
        await sleep(at(15));
      }
    })();
    await Promise.all([scoring, watching, browsing]);
    mark("p2", "steady state finished");
  }

  // P2b — peak: double the audience with read-only viewers, sample the curve, then settle
  // before any injection so a later failure cannot be blamed on the teardown.
  if (runs("p2b")) {
    const burst = [];
    for (let index = 0; index < 100; index += 1) {
      burst.push(await readerActor(browser, `burst:${index + 1}`, `/e/${code}/live/`));
    }
    mark("p2b", `burst viewers: ${burst.length}`);
    const sampled = (async () => {
      for (let tick = 300; tick < 410; tick += 15) {
        await waitUntil(tick);
        const sample = await probeHealth();
        measurements.push({ name: "healthz_probe", ms: sample.ms, status: sample.status });
        record({ actor: "probe", action: "healthz", ms: sample.ms, status: sample.status });
      }
    })();
    const loading = (async () => {
      while (Date.now() - startedAt < at(410)) await pollLive(burst, 20);
    })();
    await Promise.all([sampled, loading]);
    for (const member of burst) await member.context.close();
    mark("p2b", `burst closed: ${burst.length}`);
    await waitUntil(420);
    mark("p2b", "settled before injections");
  }

  // P3 — injections.
  if (runs("p3")) {
    const judgeDesk = cast.staff.find((member) => member.credentials.role === "judge-desk");
    const checkIn = cast.staff.find((member) => member.credentials.role === "check-in");
    const activityPath = `${baseUrl}/staff/activities/${manifest.activity.id}/`;
    const toggle = () => judgeDesk.page.locator('form[action*="judge-entry/toggle"] button');

    await waitUntil(420);
    await judgeDesk.page.goto(`${baseUrl}/staff/judges/round/${manifest.rounds.r1}/control/`);
    await judgeDesk.page.getByPlaceholder("暂停评委组原因").fill("负载演练暂停");
    await judgeDesk.page.getByRole("button", { name: "暂停评委组" }).click();
    mark("p3", "hold");

    await waitUntil(440);
    await submitJudgeScore(cast.judges[0], "66.00"); // must be refused while HOLD
    mark("p3", "score attempted during hold");

    await waitUntil(460);
    await judgeDesk.page.getByRole("button", { name: "恢复评委组" }).click();
    mark("p3", "resume");

    await waitUntil(480);
    await judgeDesk.page.goto(activityPath);
    await toggle().click();
    mark("p3", "entry closed");

    await waitUntil(500);
    const blocked = await judgeActor(browser, "judge:after-close");
    record({ actor: "judge:after-close", action: "claim_blocked", status: ((await blocked.page.locator("[data-status]").textContent()) ?? "").slice(0, 40) });
    await blocked.context.close();

    await waitUntil(520);
    await judgeDesk.page.goto(activityPath);
    await judgeDesk.page.locator('form[action*="judge-entry/rotate"] button').click();
    mark("p3", "entry rotated");

    await waitUntil(540);
    const revoked = manifest.tickets.revoked[0];
    await cast.admin.page.goto(`${baseUrl}/staff/tickets/${revoked.ticket_id}/`);
    await cast.admin.page.getByRole("button", { name: "撤销" }).click();
    mark("p3", `ticket revoked: ${revoked.serial}`);

    await waitUntil(560);
    docker("stop", realtimeContainer);
    mark("p3", "realtime stopped");

    await waitUntil(580);
    await submitJudgeScore(cast.judges[1], "77.00"); // HTTP must still work without the socket
    docker("start", realtimeContainer);
    mark("p3", "realtime started");

    await waitUntil(600);
    docker("stop", redisContainer);
    docker("start", redisContainer);
    mark("p3", "redis restarted");

    await waitUntil(620);
    await judgeDesk.page.goto(activityPath);
    await toggle().click();
    mark("p3", "entry reopened");

    await waitUntil(640);
    await checkIn.page.goto(`${baseUrl}/staff/tickets/check-in-page/`);
    await checkIn.page
      .locator("[data-ticket-check-in-form] input[name=secret]")
      .fill(manifest.tickets.valid_not_checked[0].credential);
    await checkIn.page.getByRole("button", { name: "确认检票" }).click();
    record({
      actor: "staff:check-in",
      action: "check_in",
      status: ((await checkIn.page.locator("[data-ticket-check-in-status]").textContent()) ?? "").slice(0, 30),
    });
    mark("p3", "check-in exercised");
  }

  // P3b — the toggle observation: two staff pages rendered before either clicks.
  if (runs("p3b")) {
    await waitUntil(680);
    const workspacePath = `/staff/activities/${manifest.activity.id}/`;
    for (let round = 0; round < 5; round += 1) {
      const first = await browser.newContext();
      const second = await browser.newContext();
      const firstPage = await actorPage(first, "toggle:first");
      const secondPage = await actorPage(second, "toggle:second");
      await Promise.all([
        loginStaff(firstPage, manifest.staff[0]),
        loginStaff(secondPage, manifest.staff[1]),
      ]);
      await Promise.all([
        firstPage.goto(`${baseUrl}${workspacePath}`),
        secondPage.goto(`${baseUrl}${workspacePath}`),
      ]);
      const label = ((await firstPage.locator('form[action*="judge-entry/toggle"] button').textContent()) ?? "").trim();
      await Promise.all([
        firstPage.locator('form[action*="judge-entry/toggle"] button').click(),
        secondPage.locator('form[action*="judge-entry/toggle"] button').click(),
      ]);
      record({ actor: "toggle", action: "both_clicked", round, label });
      await first.close();
      await second.close();
    }
    mark("p3b", "toggle observation finished");
  }

  await waitUntil(720);
}

try {
  await run();
} catch (error) {
  record({ actor: "runner", action: "aborted", error: String(error).slice(0, 300) });
  process.exitCode = 1;
} finally {
  for (const member of [...cast.staff, ...cast.judges, ...cast.audience, ...cast.public, cast.admin].filter(Boolean)) {
    await member.context?.close().catch(() => {});
  }
  await browser.close();
}

// --- report -----------------------------------------------------------------------------

const serverErrors = httpFailures.filter((failure) => failure.status === 500);
const proxyErrors = httpFailures.filter((failure) => [502, 504].includes(failure.status));
const otherErrors = httpFailures.filter((failure) => ![500, 502, 504].includes(failure.status));

function summarize(samples) {
  if (!samples.length) return { count: 0 };
  const values = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const pick = (fraction) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
  return { count: values.length, min: values[0], p50: pick(0.5), p95: pick(0.95), max: values[values.length - 1] };
}

const report = {
  product_revision: manifest.product_revision,
  base_url: baseUrl,
  speed: SPEED,
  duration_seconds: Math.round((Date.now() - startedAt) / 1000),
  cast: {
    judges_seated: readySeats.length,
    expected_judge_seats: manifest.judge_seats.length,
    seats: readySeats.slice().sort(),
    audience: cast.audience.length,
    audience_voted: cast.audience.filter((member) => member.voted).length,
    public_pages: cast.public.length,
    staff: cast.staff.length,
  },
  hard_checks: {
    django_500_count: serverErrors.length,
    proxy_502_504_count: proxyErrors.length,
    other_4xx_5xx_count: otherErrors.length,
  },
  http_failures: httpFailures.slice(0, 300),
  measurements: {
    judge_score: summarize(measurements.filter((sample) => sample.name === "judge_score")),
    vote_submit: summarize(measurements.filter((sample) => sample.name === "vote_submit")),
    healthz_probe: summarize(measurements.filter((sample) => sample.name === "healthz_probe")),
  },
  timeline,
};

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(
  `site load rehearsal finished in ${report.duration_seconds}s: ` +
    `${JSON.stringify(report.hard_checks)} → ${reportPath}\n`,
);
if (serverErrors.length > 0) {
  process.stdout.write(`FAIL: ${serverErrors.length} Django 500 responses.\n`);
  process.exitCode = 1;
}
