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
let stage = "p1";
// Every response an instrumented page sees, at any status. The peak's abort line is a *rate*,
// and a rate needs a denominator: counting only the failures left the rule dividing by the
// number of viewers, which is not what the plan asks for.
let responsesSeen = 0;

function record(entry) {
  const line = JSON.stringify({ t: ((Date.now() - startedAt) / 1000).toFixed(1), ...entry });
  appendFileSync(actorsLogPath, `${line}\n`);
}
function mark(phase, note = "") {
  stage = phase;
  timeline.push({ phase, note, t: (Date.now() - startedAt) / 1000 });
  record({ actor: "phase", action: phase, note });
}
function actorPage(context, actor) {
  const page = context.newPage();
  return page.then((resolved) => {
    resolved.on("response", (response) => {
      responsesSeen += 1;
      if (response.status() >= 400) {
        httpFailures.push({
          actor,
          status: response.status(),
          url: response.url(),
          stage,
          t: (Date.now() - startedAt) / 1000,
        });
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
    .filter({ hasText: /评分已确认|网络暂时不可用|现场暂停|不接受|失败|无效|已经提交过/ })
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
  try {
    await page.goto(`${baseUrl}${startPath}`, { timeout: 20000 });
    await page.locator("body").waitFor({ timeout: 20000 });
  } catch (error) {
    // Recorded, not fatal: a page that never renders is a finding about the stack, and
    // throwing here ended a rehearsal at the first one.
    record({ actor: label, action: "open", failed: String(error).slice(0, 60) });
  }
  return { label, context, page };
}

async function pollLive(members, intervalSeconds) {
  for (const group of chunk(members, 25)) {
    await Promise.all(group.map((member) => member.page.reload().catch(() => {})));
  }
  await sleep(at(intervalSeconds));
}

/** A staff member on the rapid-score grid: fills cells, watches the save land. */
async function rapidScoreActor(browser, label, credentials, roundId) {
  const context = await browser.newContext();
  const page = await actorPage(context, label);
  await loginStaff(page, credentials);
  await page.goto(`${baseUrl}/staff/rounds/${roundId}/scores/`);
  await page.locator("[data-saved-count]").waitFor({ timeout: 20000 });
  const cells = await page.locator("input[data-singer-id][data-judge-id]").count();
  record({ actor: label, action: "grid_ready", cells });
  return { label, context, page, credentials, cells };
}

async function fillScoreCell(actor, singerId, judgeId, value) {
  const cell = actor.page.locator(
    `input[data-singer-id="${singerId}"][data-judge-id="${judgeId}"]`,
  );
  if ((await cell.count()) === 0) {
    record({ actor: actor.label, action: "score_cell", missing: `${singerId}/${judgeId}` });
    return false;
  }
  const before = Number((await actor.page.locator("[data-saved-count]").textContent()) ?? 0) || 0;
  const started = Date.now();
  await cell.fill(value);
  await cell.blur();
  try {
    await actor.page.waitForFunction(
      (expected) => Number(document.querySelector("[data-saved-count]")?.textContent ?? 0) > expected,
      before,
      { timeout: 10000 },
    );
  } catch {
    // Timed out: fall through and let the conflict text say what happened.
  }
  const elapsed = Date.now() - started;
  // The saved counter moves for a *round trip*, not for an accepted write: a write the server
  // refused because the page was a revision behind still resolves. The conflict line is the
  // observable that separates "accepted" from "refused and reported", so it is read every
  // time rather than only on the timeout path.
  const conflictText = await actor.page
    .locator("[data-conflicts]")
    .textContent()
    .catch(() => "");
  const conflicts = (conflictText ?? "").trim();
  const accepted = conflicts.length === 0;
  if (accepted) measurements.push({ name: "rapid_score_save", ms: elapsed });
  record({
    actor: actor.label,
    action: "score_cell",
    singer: singerId,
    value,
    accepted,
    conflicts: conflicts.slice(0, 60),
  });
  return accepted;
}

/** A participant: sign in and upload a file answer through the real questionnaire page. */
async function participantUpload(browser, label) {
  const context = await browser.newContext();
  const page = await actorPage(context, label);
  await page.goto(`${baseUrl}/login/participant/`);
  await page.getByLabel("用户名").fill(manifest.participant.username);
  await page.getByLabel("密码").fill(manifest.participant.password);
  await page.getByRole("button", { name: "登录" }).click();
  // The registration activity, not the show activity: an upload only exists while the
  // registration window is open, and the show one is in LIVE where the form is closed.
  await page.goto(`${baseUrl}/questionnaire/${manifest.registration_activity.id}/`);
  const form = page.locator("[data-questionnaire-form]");
  await form.waitFor({ timeout: 20000 });
  const fileInput = page.locator('input[type="file"][data-file-answer]').first();
  if ((await fileInput.count()) === 0) {
    record({ actor: label, action: "upload", missing: "no file question on the form" });
    return { label, context, page, uploaded: false };
  }
  const key = await fileInput.getAttribute("data-file-answer");
  const filePath = path.join(outputDir, "answer.mp3");
  writeFileSync(filePath, Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]), // "ID3" + version
    Buffer.alloc(2048),
  ]));
  const started = Date.now();
  let uploaded = false;
  try {
    const beforeVersion = (await fileInput.getAttribute("data-file-version")) ?? "";
    await fileInput.setInputFiles(filePath);
    // The observable is the version the server assigns to the stored file: waiting for the
    // input to *exist* already succeeded before the upload started, and measured a timeout.
    await page.waitForFunction(
      ([key, before]) =>
        document
          .querySelector(`input[data-file-answer="${key}"]`)
          ?.getAttribute("data-file-version") !== before,
      [key, beforeVersion],
      { timeout: 15000 },
    );
    uploaded = true;
    measurements.push({ name: "file_upload", ms: Date.now() - started });
  } catch (error) {
    record({ actor: label, action: "upload", failed: String(error).slice(0, 60) });
  }
  record({ actor: label, action: "upload", question: key, uploaded });
  return { label, context, page, uploaded, filePath };
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

// The machine's system proxy has to be taken out of the path, and it has to be explicit.
//
// This host runs an enterprise proxy as the WinINET system proxy, and the browser sends even
// loopback URLs to it: the peer for http://127.0.0.1:8000 was 127.0.0.1:12334, not Caddy. A
// bypass list alone does not help — `--proxy-bypass-list=127.0.0.1;localhost` still went to the
// proxy. `direct://` does. It matters because the proxy answers a share of the loopback
// requests with its own 502 while forwarding the rest: the two earlier runs recorded 668 and 13
// such 502s on the live page, and neither Caddy's log nor the web container's access log has a
// single entry to match. Measuring that proxy and calling it "the stack's capacity" is the one
// mistake this harness must not make again, so the launch is pinned here and checked below.
const browser = await chromium.launch({ args: ["--proxy-server=direct://"] });

// The check that makes the pin above load-bearing: if a future run is pointed at a proxy again,
// it fails immediately instead of producing a plausible-looking curve.
async function assertDirectConnection() {
  const probe = await browser.newContext();
  const page = await probe.newPage();
  let peer = null;
  page.on("response", async (response) => {
    if (peer !== null) return;
    const address = await response.serverAddr().catch(() => null);
    peer = address ? `${address.ipAddress}:${address.port}` : "";
  });
  await page.goto(`${baseUrl}/healthz/`, { timeout: 15000 });
  // The response listener is async (reading the peer address is a round trip to the browser),
  // so it can land after goto resolves.
  for (let attempt = 0; attempt < 50 && peer === null; attempt += 1) await sleep(100);
  await probe.close();
  const expected = `${base.hostname}:${base.port || (base.protocol === "https:" ? 443 : 80)}`;
  if (peer !== expected) {
    throw new Error(
      `The browser is not talking to the stack: /healthz/ was answered by "${peer || "no peer"}", ` +
        `not ${expected}. A proxy in the path fabricates 502s the server never sees.`,
    );
  }
  record({ actor: "preflight", action: "direct_connection", peer });
}

const cast = { judges: [], audience: [], public: [], staff: [] };

async function run() {
  await assertDirectConnection();

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

    for (let index = 0; index < manifest.judge_seats.length; index += 1) {
      cast.judges.push(await judgeActor(browser, `judge:${index + 1}`, { dropFirstAck: index === 1 }));
    }
    record({ actor: "judges", action: "seated", seats: readySeats.slice().sort() });

    // The sixth device only after the five are seated: it is refused *because* they are, and
    // running it first made it take a seat a teacher needed.
    const overflow = await judgeActor(browser, "judge:overflow");
    await overflow.context.close();

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

    // The two roles the first run never exercised: staff entering scores on the grid, and a
    // participant uploading through the questionnaire.
    cast.rapid = [];
    for (const role of ["score-entry", "backstage"]) {
      const credentials = manifest.staff.find((member) => member.role === role);
      cast.rapid.push(
        await rapidScoreActor(browser, `rapid:${role}`, credentials, manifest.rounds.r1),
      );
    }
    cast.upload = await participantUpload(browser, "participant:upload");
    mark("p1", `cast ready: ${cast.judges.length} judges, ${cast.audience.length} audience, ${cast.rapid.length} on the score grid`);
  }

  // P2 — steady state: judges score, the audience watches.
  if (runs("p2")) {
    // Without this the whole steady state inherits the P1 label, because `stage` only moves in
    // mark() — and then every 4xx the voting and scoring paths answer on purpose is filed under
    // "cold start".
    mark("p2", "steady state started");
    const judgeDesk = cast.staff.find((member) => member.credentials.role === "judge-desk");
    const controlUrl = `${baseUrl}/staff/judges/round/${manifest.rounds.r1}/control/`;
    const scoring = (async () => {
      let round = 0;
      while (Date.now() - startedAt < at(240)) {
        // One score per seat per performance is enforced, so the performers have to change
        // between rounds — otherwise the loop measures the refusal path and calls it scoring.
        const target = manifest.performances[round % manifest.performances.length];
        try {
          await judgeDesk.page.goto(controlUrl);
          await judgeDesk.page
            .locator(`form:has(input[name="performance_id"][value="${target.id}"]) button`)
            .first()
            .click({ timeout: 5000 });
          await judgeDesk.page.waitForLoadState("domcontentloaded");
        } catch (error) {
          record({ actor: "staff:judge-desk", action: "advance", failed: String(error).slice(0, 60) });
        }
        round += 1;
        for (const judge of cast.judges) await submitJudgeScore(judge, String(85 + (round % 10)));
        await sleep(at(4));
      }
    })();
    const watching = (async () => {
      // The audience's real load is the live page polling, not repeated voting: a ticket
      // votes once, and a rehearsal that keeps re-submitting would measure the refusal path
      // instead of the site.
      while (Date.now() - startedAt < at(240)) {
        await pollLive(cast.audience, 10);
      }
    })();
    const grid = (async () => {
      const [first, second] = cast.rapid;
      let round = 0;
      while (Date.now() - startedAt < at(240)) {
        round += 1;
        const singer = manifest.performers[round % manifest.performers.length].singer_id;
        const cell = first.page.locator(`input[data-singer-id="${singer}"]`).first();
        const judgeId = await cell.getAttribute("data-judge-id").catch(() => null);
        if (judgeId === null && round === 1) {
          record({
            actor: first.label,
            action: "grid_lookup_failed",
            singer,
            grid_cells: first.cells,
            sample: ((await first.page.locator("[data-saved-count]").textContent()) ?? "").slice(0, 20),
          });
        }
        if (judgeId) {
          await fillScoreCell(first, singer, judgeId, String(80 + (round % 10)));
          // `second` has not reloaded since `first` saved, so its write carries a stale grid
          // version. The grid has to refuse it *and* say so rather than apply it quietly.
          await fillScoreCell(second, singer, judgeId, String(90 + (round % 5)));
        }
        // A second upload, which is also the version-retention path.
        if (cast.upload?.uploaded && round % 3 === 0) {
          await cast.upload.page
            .locator('input[type="file"][data-file-answer]')
            .first()
            .setInputFiles(cast.upload.filePath)
            .catch(() => {});
          record({ actor: "participant:upload", action: "upload_again", round });
        }
        await sleep(at(6));
      }
    })();
    const browsing = (async () => {
      while (Date.now() - startedAt < at(240)) {
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
    await Promise.all([scoring, grid, watching, browsing]);
    mark("p2", "steady state finished");
  }

  // P2b — a staged ramp. The first attempt at this phase measured almost nothing: creating a
  // hundred viewers took 81 s of the 110 s window, so the window was mostly context creation.
  // The viewers are built during P2 now, and the window only varies how many of them poll.
  const ramp = [];
  if (runs("p2b")) {
    await waitUntil(240);
    for (const group of chunk([...Array(200).keys()], 20)) {
      ramp.push(
        ...(await Promise.all(
          group.map((index) => readerActor(browser, `ramp:${index + 1}`, `/e/${code}/live/`)),
        )),
      );
    }
    mark("p2b", `ramp viewers ready: ${ramp.length}`);
    await waitUntil(300);

    const stages = [50, 100, 150, 200];
    let previous = 0;
    for (const target of stages) {
      mark("p2b", `stage ${target}`);
      const active = ramp.slice(0, target);
      const stageStarted = Date.now();
      const stageFailuresBefore = httpFailures.length;
      const stageResponsesBefore = responsesSeen;
      const samples = [];
      const loading = (async () => {
        while (Date.now() - stageStarted < at(20)) await pollLive(active, 5);
      })();
      const sampling = (async () => {
        while (Date.now() - stageStarted < at(20)) {
          const sample = await probeHealth();
          samples.push(sample);
          measurements.push({ name: `probe_${target}`, ms: sample.ms, status: sample.status });
          await sleep(at(5));
        }
      })();
      await Promise.all([loading, sampling]);
      const failed = httpFailures.slice(stageFailuresBefore).filter((f) => [502, 504, 500].includes(f.status)).length;
      const requests = responsesSeen - stageResponsesBefore;
      const worst = samples.reduce((max, sample) => Math.max(max, sample.ms), 0);
      record({
        actor: "ramp",
        action: "stage",
        viewers: target,
        added: target - previous,
        requests,
        failures: failed,
        probe_max_ms: worst,
      });
      previous = target;
      // The plan's abort line for the peak: past this the bend has already been found, and
      // more load only buries the evidence. The denominator is the requests the stage actually
      // served — one viewer at 5 s per poll makes ~4 reloads, and every reload is a page *and*
      // a state fetch, so dividing by the viewer count alone was four times stricter than the
      // plan and ended the first real ramp at its very first stage.
      const failureRate = requests > 0 ? failed / requests : 0;
      if (failureRate > 0.05 || worst > 5000) {
        record({
          actor: "ramp",
          action: "aborted_stage",
          viewers: target,
          requests,
          failures: failed,
          failure_rate: Number(failureRate.toFixed(4)),
          probe_max_ms: worst,
        });
        break;
      }
    }
    for (const member of ramp) await member.context.close();
    mark("p2b", `ramp closed: ${ramp.length}`);
    mark("p2b", "settled before injections");
  }

  // P3 — injections.
  if (runs("p3")) {
    const judgeDesk = cast.staff.find((member) => member.credentials.role === "judge-desk");
    const checkIn = cast.staff.find((member) => member.credentials.role === "check-in");
    const activityPath = `${baseUrl}/staff/activities/${manifest.activity.id}/workspace/`;
    const toggle = () => judgeDesk.page.locator('form[action*="judge-entry/toggle"] button');

    await waitUntil(400);
    await judgeDesk.page.goto(`${baseUrl}/staff/judges/round/${manifest.rounds.r1}/control/`);
    await judgeDesk.page.getByPlaceholder("暂停评委组原因").fill("负载演练暂停");
    await judgeDesk.page.getByRole("button", { name: "暂停评委组" }).click();
    mark("p3", "hold");

    await waitUntil(420);
    await submitJudgeScore(cast.judges[0], "66.00"); // must be refused while HOLD
    mark("p3", "score attempted during hold");

    await waitUntil(440);
    await judgeDesk.page.getByRole("button", { name: "恢复评委组" }).click();
    mark("p3", "resume");

    await waitUntil(460);
    await judgeDesk.page.goto(activityPath);
    await toggle().click();
    mark("p3", "entry closed");

    await waitUntil(480);
    const blocked = await judgeActor(browser, "judge:after-close");
    record({ actor: "judge:after-close", action: "claim_blocked", status: ((await blocked.page.locator("[data-status]").textContent()) ?? "").slice(0, 40) });
    await blocked.context.close();

    await waitUntil(500);
    await judgeDesk.page.goto(activityPath);
    await judgeDesk.page.locator('form[action*="judge-entry/rotate"] button').click();
    mark("p3", "entry rotated");

    await waitUntil(520);
    // A ticket that has been *used*: the point is that its ballot stays on file as evidence
    // while it leaves the valid set. Revoking one that is already revoked has no button to
    // press, which is what the first attempt at this step found.
    const revoked = manifest.tickets.valid_checked_in[0];
    try {
      await cast.admin.page.goto(`${baseUrl}/staff/tickets/${revoked.ticket_id}/detail/`);
      await cast.admin.page.getByRole("button", { name: "撤销" }).click({ timeout: 10000 });
      mark("p3", `ticket revoked: ${revoked.serial}`);
    } catch (error) {
      record({ actor: "admin", action: "revoke_ticket", failed: String(error).slice(0, 60) });
    }
    const revokedActor = cast.audience.find((member) => member.ticket.ticket_id === revoked.ticket_id);
    if (revokedActor) {
      // The same browser that voted a moment ago: its session is now void and a second ballot
      // must not appear, even though the first one stays on file.
      const again = await castVote(revokedActor.page, `${revokedActor.label}:after-revoke`);
      record({ actor: revokedActor.label, action: "vote_after_revoke", accepted: again });
    }

    await waitUntil(540);
    docker("stop", realtimeContainer);
    mark("p3", "realtime stopped");

    await waitUntil(556);
    // A judge terminal can only answer for the performance it is looking at, and by this point
    // every seat has already scored the one on screen — the earlier run's submission here was
    // refused with "该评委席位已经提交过此表演的评分", which proves the HTTP chain *answered* but
    // leaves the plan's "a write lands with the socket down" unproven. The rapid-score grid takes
    // a formal write (staff_rapid) that does not depend on the performance context, so it is the
    // probe that can actually land: one cell, re-valued, and its receipt is the evidence.
    const gridProbe = cast.rapid[0];
    if (gridProbe) {
      // Reloaded first: the page has been open since P2 and a version it dragged along would
      // make this probe measure the stale-write guard instead of the outage.
      await gridProbe.page.goto(`${baseUrl}/staff/rounds/${manifest.rounds.r1}/scores/`);
      await gridProbe.page.locator("[data-saved-count]").waitFor({ timeout: 20000 });
      const singer = manifest.performers[manifest.performers.length - 1].singer_id;
      const cell = gridProbe.page.locator(`input[data-singer-id="${singer}"]`).first();
      const judgeId = await cell.getAttribute("data-judge-id").catch(() => null);
      if (judgeId) {
        const accepted = await fillScoreCell(gridProbe, singer, judgeId, "99");
        record({ actor: gridProbe.label, action: "write_while_realtime_down", singer, accepted });
      } else {
        record({ actor: gridProbe.label, action: "write_while_realtime_down", missing: "grid cell" });
      }
    }
    await waitUntil(560);
    await submitJudgeScore(cast.judges[1], "77.00"); // HTTP must still work without the socket
    docker("start", realtimeContainer);
    mark("p3", "realtime started");

    await waitUntil(580);
    docker("stop", redisContainer);
    docker("start", redisContainer);
    mark("p3", "redis restarted");

    await waitUntil(600);
    await judgeDesk.page.goto(activityPath);
    await toggle().click();
    mark("p3", "entry reopened");

    await waitUntil(620);
    await checkIn.page.goto(`${baseUrl}/staff/tickets/check-in-page/`);
    await checkIn.page
      .locator("[data-ticket-check-in-form] input[name=secret]")
      .fill(manifest.tickets.valid_not_checked[0].credential);
    await checkIn.page.getByRole("button", { name: "确认检票" }).click();
    const checkInStatus = checkIn.page
      .locator("[data-ticket-check-in-status]")
      .filter({ hasText: /检票成功|已检票|无效|失败/ });
    await checkInStatus.waitFor({ timeout: 10000 }).catch(() => {});
    record({
      actor: "staff:check-in",
      action: "check_in",
      status: ((await checkInStatus.textContent().catch(() => "")) ?? "").slice(0, 30),
    });
    mark("p3", "check-in exercised");
  }

  // P3b — the toggle observation: two staff pages rendered before either clicks.
  if (runs("p3b")) {
    await waitUntil(680);
    const workspacePath = `/staff/activities/${manifest.activity.id}/workspace/`;
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
    rapid_score_save: summarize(measurements.filter((sample) => sample.name === "rapid_score_save")),
    file_upload: summarize(measurements.filter((sample) => sample.name === "file_upload")),
    by_stage: Object.fromEntries(
      [...new Set(measurements.map((sample) => sample.name))].map((name) => [
        name,
        summarize(measurements.filter((sample) => sample.name === name)),
      ]),
    ),
  },
  // Which load level produced which failures: the whole point of ramping instead of
  // switching the burst on in one step.
  failures_by_stage: httpFailures.reduce((accumulator, failure) => {
    accumulator[failure.stage] = accumulator[failure.stage] ?? {};
    const key = String(failure.status);
    accumulator[failure.stage][key] = (accumulator[failure.stage][key] ?? 0) + 1;
    return accumulator;
  }, {}),
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
