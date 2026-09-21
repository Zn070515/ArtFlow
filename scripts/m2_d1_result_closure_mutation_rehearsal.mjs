#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturePath = process.env.ARTFLOW_CLOSURE_FIXTURE_PATH;
if (!fixturePath) throw new Error("ARTFLOW_CLOSURE_FIXTURE_PATH is required.");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const rawBaseUrl = process.env.ARTFLOW_REHEARSAL_BASE_URL ?? "http://127.0.0.1:8000";
const base = new URL(rawBaseUrl);
const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
if (base.protocol !== "http:" || !allowedHosts.has(base.hostname)) {
  throw new Error("This rehearsal only accepts an HTTP service on localhost/127.0.0.1/::1.");
}
const baseUrl = rawBaseUrl.replace(/\/$/, "");
const timeoutMs = 5000;
const postHeaders = {
  Cookie: fixture.session_cookie,
  "Content-Type": "application/x-www-form-urlencoded",
  "X-CSRFToken": fixture.csrf_token,
};

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      redirect: "manual",
      ...options,
      headers: { Cookie: fixture.session_cookie, ...(options.headers ?? {}) },
      signal: controller.signal,
    });
    return {
      status: response.status,
      location: response.headers.get("location") ?? "",
      body: await response.text(),
      durationMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestArchive(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      redirect: "manual",
      headers: postHeaders,
      signal: controller.signal,
    });
    return {
      status: response.status,
      body: Buffer.from(await response.arrayBuffer()),
      durationMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function percentile(values, percentage) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((percentage / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

async function archiveMarkers(archive, markers) {
  const archivePath = path.join(os.tmpdir(), `artflow-m2-d1-${process.pid}-${Date.now()}.zip`);
  await writeFile(archivePath, archive);
  const inspector = [
    "import io,json,sys,zipfile",
    "z=zipfile.ZipFile(sys.argv[1])",
    "def flatten(part):",
    "    if not zipfile.is_zipfile(io.BytesIO(part)): return part",
    "    with zipfile.ZipFile(io.BytesIO(part)) as inner: return b''.join(inner.read(n) for n in inner.namelist())",
    "text=b''.join(flatten(z.read(n)) for n in z.namelist()).decode('utf-8','ignore')",
    "z.close()",
    "print(json.dumps({m: m in text for m in sys.argv[2:]}))",
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(
      process.env.ARTFLOW_PYTHON ?? "python",
      ["-c", inspector, archivePath, ...markers],
      { maxBuffer: 2 * 1024 * 1024, timeout: timeoutMs },
    );
    return JSON.parse(stdout.trim());
  } finally {
    await unlink(archivePath).catch(() => {});
  }
}

async function inspectFixture() {
  const { stdout } = await execFileAsync(
    process.env.ARTFLOW_DOCKER ?? "docker",
    [
      "compose",
      "exec",
      "-T",
      "web",
      "python",
      "manage.py",
      "inspect_result_closure_rehearsal",
      "--fixture",
      fixture.container_fixture_path,
    ],
    { maxBuffer: 2 * 1024 * 1024, timeout: timeoutMs },
  );
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line) throw new Error("The rehearsal inspector returned no JSON report.");
  return JSON.parse(line);
}

const checks = [];
const confirm = await request(fixture.confirm_path, { method: "POST", headers: postHeaders });
const afterConfirm = await inspectFixture();
checks.push({
  name: "first confirm is accepted and persisted by the real HTTP boundary",
  passed:
    confirm.status === 302 &&
    afterConfirm.current_stage_status === "confirmed" &&
    afterConfirm.confirm_audit_count === 1,
  status: confirm.status,
  persisted_status: afterConfirm.current_stage_status,
  confirm_audit_count: afterConfirm.confirm_audit_count,
  duration_ms: Math.round(confirm.durationMs * 100) / 100,
});

const replay = await request(fixture.confirm_path, { method: "POST", headers: postHeaders });
const afterReplay = await inspectFixture();
checks.push({
  name: "duplicate confirm is idempotent at the real HTTP boundary and database",
  passed:
    replay.status === 302 &&
    afterReplay.current_stage_status === "confirmed" &&
    afterReplay.confirm_audit_count === 1,
  status: replay.status,
  persisted_status: afterReplay.current_stage_status,
  confirm_audit_count: afterReplay.confirm_audit_count,
  duration_ms: Math.round(replay.durationMs * 100) / 100,
});

const stale = await request(fixture.stale_confirm_path, { method: "POST", headers: postHeaders });
const afterStale = await inspectFixture();
checks.push({
  name: "stale result is rejected at the real HTTP boundary and database",
  passed:
    stale.status === 302 &&
    afterStale.current_stage_status === "confirmed" &&
    afterStale.stale_stage_status !== "confirmed" &&
    afterStale.stale_confirm_audit_count === 0,
  status: stale.status,
  current_stage_status: afterStale.current_stage_status,
  stale_stage_status: afterStale.stale_stage_status,
  stale_confirm_audit_count: afterStale.stale_confirm_audit_count,
  duration_ms: Math.round(stale.durationMs * 100) / 100,
});

const confirmedArchive = await requestArchive(fixture.archive_path);
const confirmedMarkers =
  confirmedArchive.status === 200
    ? await archiveMarkers(confirmedArchive.body, [
        fixture.current_award_marker,
        fixture.foreign_award_marker,
      ])
    : { [fixture.current_award_marker]: false, [fixture.foreign_award_marker]: false };
checks.push({
  name: "confirmed archive contains only the current activity's official award",
  passed:
    confirmedArchive.status === 200 &&
    confirmedMarkers[fixture.current_award_marker] === true &&
    confirmedMarkers[fixture.foreign_award_marker] === false,
  status: confirmedArchive.status,
  markers: confirmedMarkers,
  duration_ms: Math.round(confirmedArchive.durationMs * 100) / 100,
});

const unlock = await request(fixture.unlock_path, {
  method: "POST",
  headers: postHeaders,
  body: "note=M2-D1%20runtime%20rehearsal%20correction",
});
checks.push({
  name: "unlock requires and accepts an audited correction reason",
  passed: unlock.status === 302,
  status: unlock.status,
  duration_ms: Math.round(unlock.durationMs * 100) / 100,
});

const unlockedArchive = await requestArchive(fixture.archive_path);
const unlockedMarkers =
  unlockedArchive.status === 200
    ? await archiveMarkers(unlockedArchive.body, [
        fixture.current_award_marker,
        fixture.foreign_award_marker,
      ])
    : { [fixture.current_award_marker]: true, [fixture.foreign_award_marker]: true };
const forgedArchive = await requestArchive(
  `${fixture.archive_path}?activity_id=${fixture.foreign_activity_id}`,
);
const forgedMarkers =
  forgedArchive.status === 200
    ? await archiveMarkers(forgedArchive.body, [
        fixture.current_award_marker,
        fixture.foreign_award_marker,
      ])
    : { [fixture.current_award_marker]: true, [fixture.foreign_award_marker]: true };
checks.push({
  name: "unlocked and forged-scope archives fail closed for old and foreign awards",
  passed:
    unlockedArchive.status === 200 &&
    forgedArchive.status === 200 &&
    unlockedMarkers[fixture.current_award_marker] === false &&
    unlockedMarkers[fixture.foreign_award_marker] === false &&
    forgedMarkers[fixture.current_award_marker] === false &&
    forgedMarkers[fixture.foreign_award_marker] === false,
  unlocked_status: unlockedArchive.status,
  forged_status: forgedArchive.status,
  unlocked_duration_ms: Math.round(unlockedArchive.durationMs * 100) / 100,
  forged_duration_ms: Math.round(forgedArchive.durationMs * 100) / 100,
  unlocked_markers: unlockedMarkers,
  forged_markers: forgedMarkers,
});

const inspection = await inspectFixture();
const allResponses = [confirm, replay, stale, unlock, confirmedArchive, unlockedArchive, forgedArchive];
const latencies = allResponses.map((result) => result.durationMs);

const report = {
  schema: "artflow.m2-d1.result-closure-mutation-rehearsal.v1",
  base_url: baseUrl,
  activity_id: fixture.activity_id,
  bounds: {
    request_timeout_ms: timeoutMs,
    public_network: false,
    mutating_authority_requests: true,
    source_database_reset: false,
  },
  metrics: {
    total_requests: 7,
    status_2xx: allResponses.filter(
      (result) => result.status >= 200 && result.status < 300,
    ).length,
    status_3xx: allResponses.filter((result) => result.status >= 300 && result.status < 400).length,
    status_4xx: allResponses.filter(
      (result) => result.status >= 400 && result.status < 500,
    ).length,
    status_5xx: allResponses.filter(
      (result) => result.status >= 500,
    ).length,
    timeout_count: 0,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p99_ms: percentile(latencies, 99),
    max_ms: Math.round(Math.max(...latencies) * 100) / 100,
    duplicate_confirm_count: inspection.duplicate_confirm_count,
    stale_rejection_count: inspection.stale_rejection_count,
    official_source_leakage_count:
      Number(confirmedMarkers[fixture.foreign_award_marker]) +
      Number(unlockedMarkers[fixture.current_award_marker]) +
      Number(unlockedMarkers[fixture.foreign_award_marker]) +
      Number(forgedMarkers[fixture.current_award_marker]) +
      Number(forgedMarkers[fixture.foreign_award_marker]),
  },
  inspection,
  checks,
};
console.log(JSON.stringify(report, null, 2));
if (
  checks.some((check) => !check.passed) ||
  report.metrics.status_5xx > 0 ||
  report.metrics.duplicate_confirm_count !== 0 ||
  report.metrics.stale_rejection_count !== 1 ||
  report.inspection.official_current_award_count !== 0
) process.exitCode = 1;
