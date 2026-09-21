#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturePath = process.env.ARTFLOW_RESULT_RELEASE_FIXTURE_PATH;
if (!fixturePath) throw new Error("ARTFLOW_RESULT_RELEASE_FIXTURE_PATH is required.");
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
const responses = [];
const checks = [];

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
    const result = {
      status: response.status,
      body: await response.text(),
      durationMs: performance.now() - startedAt,
      timedOut: false,
    };
    responses.push(result);
    return result;
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    const result = {
      status: 0,
      body: "",
      durationMs: performance.now() - startedAt,
      timedOut: true,
    };
    responses.push(result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function postForm(pathname, values) {
  return request(pathname, {
    method: "POST",
    headers: postHeaders,
    body: new URLSearchParams(values).toString(),
  });
}

function percentile(values, percentage) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((percentage / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

function check(name, passed, details = {}) {
  const result = { name, passed, ...details };
  checks.push(result);
  return result;
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
      "inspect_result_release_rehearsal",
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

async function cleanupFixture() {
  await execFileAsync(
    process.env.ARTFLOW_DOCKER ?? "docker",
    [
      "compose",
      "exec",
      "-T",
      "web",
      "python",
      "manage.py",
      "cleanup_result_release_rehearsal",
      "--fixture",
      fixture.container_fixture_path,
    ],
    { maxBuffer: 2 * 1024 * 1024, timeout: timeoutMs },
  );
}

let inspection;
try {
  const initialDetail = await request(fixture.public_post_path);
  check("direct PUBLISHED result without release stays private", initialDetail.status === 404, {
    status: initialDetail.status,
  });
  const initialMedia = await request(fixture.media_url_path);
  check("media for an unreleased result stays private", initialMedia.status === 404, {
    status: initialMedia.status,
  });
  const initialResults = await request(fixture.public_results_path);
  check("unreleased result is absent from result list", !initialResults.body.includes(fixture.public_title), {
    status: initialResults.status,
  });

  const confirm = await postForm(fixture.confirm_path, {});
  check("current result confirmation succeeds", confirm.status === 302, { status: confirm.status });
  const releaseValues = { stage_result_id: String(fixture.stage_id), note: "M2-D2 rehearsal release" };
  const release = await postForm(fixture.release_path, releaseValues);
  check("explicit result release succeeds", release.status === 302, { status: release.status });
  const duplicate = await postForm(fixture.release_path, releaseValues);
  check("duplicate result release is idempotent", duplicate.status === 302, { status: duplicate.status });
  const forged = await postForm(
    `${fixture.release_path}?activity_id=${fixture.foreign_activity_id}&stage_result_id=${fixture.foreign_stage_id}`,
    { stage_result_id: String(fixture.foreign_stage_id), note: "forged cross-activity release" },
  );
  check("cross-activity stage forgery is rejected", forged.status === 404, { status: forged.status });
  const edit = await postForm(fixture.edit_path, {
    title: "M2-D2 tampered result",
    subtitle: "",
    content: "",
    post_type: "result_publication",
    status: "published",
    sort_order: "0",
    related_activity_id: String(fixture.activity_id),
    base_version: "0",
  });
  check("active release freezes post editing", edit.status === 403, { status: edit.status });

  const visibleDetail = await request(`${fixture.public_post_path}?activity_id=${fixture.foreign_activity_id}`);
  check("active release is visible through path-owned detail", visibleDetail.status === 200, {
    status: visibleDetail.status,
  });
  const visibleMedia = await request(fixture.media_url_path);
  check("active release permits its controlled media", visibleMedia.status === 200, {
    status: visibleMedia.status,
  });
  const visibleResults = await request(fixture.public_results_path);
  check("active release appears in result list", visibleResults.body.includes(fixture.public_title), {
    status: visibleResults.status,
  });

  const revoke = await postForm(fixture.revoke_path, { note: "M2-D2 rehearsal revoke" });
  check("explicit revoke succeeds", revoke.status === 302, { status: revoke.status });
  const revokedDetail = await request(fixture.public_post_path);
  check("revoked release hides the old public URL", revokedDetail.status === 404, {
    status: revokedDetail.status,
  });
  const revokedMedia = await request(fixture.media_url_path);
  check("revoked release hides controlled media", revokedMedia.status === 404, {
    status: revokedMedia.status,
  });

  const rerelease = await postForm(fixture.release_path, releaseValues);
  check("a reviewed result can be explicitly re-released", rerelease.status === 302, {
    status: rerelease.status,
  });
  const rereleasedDetail = await request(fixture.public_post_path);
  check("re-release restores only the current public result", rereleasedDetail.status === 200, {
    status: rereleasedDetail.status,
  });

  const unlock = await postForm(fixture.unlock_path, { note: "M2-D2 rehearsal correction" });
  check("unlock supersedes the active result release", unlock.status === 302, {
    status: unlock.status,
  });
  const unlockedDetail = await request(fixture.public_post_path);
  check("unlocked result is private again", unlockedDetail.status === 404, {
    status: unlockedDetail.status,
  });
  const unlockedMedia = await request(fixture.media_url_path);
  check("unlocked result media is private again", unlockedMedia.status === 404, {
    status: unlockedMedia.status,
  });

  inspection = await inspectFixture();
  check(
    "database inspector records one idempotent release, one revoke, and one supersede",
    inspection.release_audit_count === 2 &&
      inspection.revoke_audit_count === 1 &&
      inspection.supersede_audit_count === 1 &&
      inspection.release_history_count === 2 &&
      inspection.active_release_count === 0 &&
      inspection.stage_status === "ready_to_confirm",
    { inspection },
  );
} finally {
  await cleanupFixture();
  await unlink(fixturePath).catch(() => {});
}

const latencies = responses.map((result) => result.durationMs);
const report = {
  schema: "artflow.m2-d2.result-release-rehearsal.v1",
  base_url: baseUrl,
  activity_id: fixture.activity_id,
  bounds: {
    request_timeout_ms: timeoutMs,
    max_requests: 32,
    public_network: false,
    source_database_reset: false,
    source_volumes_reset: false,
  },
  metrics: {
    total_requests: responses.length,
    status_2xx: responses.filter((result) => result.status >= 200 && result.status < 300).length,
    status_3xx: responses.filter((result) => result.status >= 300 && result.status < 400).length,
    status_4xx: responses.filter((result) => result.status >= 400 && result.status < 500).length,
    status_5xx: responses.filter((result) => result.status >= 500).length,
    timeout_count: responses.filter((result) => result.timedOut).length,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p99_ms: percentile(latencies, 99),
    max_ms: Math.round(Math.max(...latencies) * 100) / 100,
  },
  inspection,
  checks,
};
console.log(JSON.stringify(report, null, 2));
if (
  responses.length > 32 ||
  report.metrics.status_5xx > 0 ||
  report.metrics.timeout_count > 0 ||
  checks.some((checkResult) => !checkResult.passed)
) process.exitCode = 1;
