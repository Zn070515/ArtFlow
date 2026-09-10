#!/usr/bin/env node

import process from "node:process";

const rawBaseUrl = process.env.ARTFLOW_REHEARSAL_BASE_URL ?? "http://127.0.0.1:18000";
const base = new URL(rawBaseUrl);
const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
if (base.protocol !== "http:" || !allowedHosts.has(base.hostname)) {
  throw new Error("This rehearsal only accepts an HTTP service on localhost/127.0.0.1/::1.");
}
const baseUrl = rawBaseUrl.replace(/\/$/, "");
const activityId = process.env.ARTFLOW_CLOSURE_ACTIVITY_ID;
if (!/^\d+$/.test(activityId ?? "")) {
  console.error("ARTFLOW_CLOSURE_ACTIVITY_ID must be a numeric test activity id.");
  process.exit(2);
}

const timeoutMs = 3000;
const requestCount = Math.min(Number(process.env.ARTFLOW_CLOSURE_REQUESTS ?? 24), 32);
const concurrency = Math.min(Number(process.env.ARTFLOW_CLOSURE_CONCURRENCY ?? 8), 8);
const staffCookie = process.env.ARTFLOW_STAFF_COOKIE;
const closurePath = `/staff/activity/${activityId}/result-closure/`;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      redirect: "manual",
      ...options,
      headers: {
        ...(staffCookie ? { Cookie: staffCookie } : {}),
        ...(options.headers ?? {}),
      },
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      status: response.status,
      durationMs: performance.now() - startedAt,
      body,
      location: response.headers.get("location") ?? "",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.name : "request-error",
      durationMs: performance.now() - startedAt,
      body: "",
      location: "",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runBounded(count, workerCount, factory) {
  const results = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      results[index] = await factory(index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function summarize(results) {
  const durations = results.map((result) => result.durationMs);
  const statusCounts = {};
  let timeoutCount = 0;
  let serverErrorCount = 0;
  let leakageCount = 0;
  for (const result of results) {
    const key = result.error ? "error" : String(result.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    if (result.error === "AbortError") timeoutCount += 1;
    if (result.status >= 500) serverErrorCount += 1;
    if (/m2d1-canary|authorization\s*:\s*bearer|secret|grant_token|session_token/i.test(result.body)) {
      leakageCount += 1;
    }
  }
  return {
    total_requests: results.length,
    status_counts: statusCounts,
    concurrency,
    p50_ms: Math.round(percentile(durations, 0.5) * 100) / 100,
    p95_ms: Math.round(percentile(durations, 0.95) * 100) / 100,
    p99_ms: Math.round(percentile(durations, 0.99) * 100) / 100,
    timeout_count: timeoutCount,
    server_error_count: serverErrorCount,
    token_secret_leakage_count: leakageCount,
  };
}

const checks = [];
const authenticatedStatus = staffCookie ? [200] : [302];
const closureResults = await runBounded(requestCount, concurrency, () =>
  request(closurePath, { headers: { Origin: "https://evil.example" } }),
);
checks.push({
  name: "closure GET stays activity-scoped",
  expected_statuses: authenticatedStatus,
  passed: closureResults.every((result) => authenticatedStatus.includes(result.status)),
  summary: summarize(closureResults),
});

const forgedQuery = await request(`${closurePath}?activity_id=999999999&stage_key=foreign-stage&result_id=999999999`);
checks.push({
  name: "closure ignores forged query authority",
  expected_statuses: authenticatedStatus,
  passed: authenticatedStatus.includes(forgedQuery.status) && !/999999999|foreign-stage/i.test(forgedQuery.body),
  status: forgedQuery.status,
  duration_ms: Math.round(forgedQuery.durationMs * 100) / 100,
});

const foreignPath = "/staff/activity/999999999/result-closure/";
const foreign = await request(foreignPath);
checks.push({
  name: "foreign activity path does not disclose closure",
  expected_statuses: staffCookie ? [404] : [302],
  passed: (staffCookie ? [404] : [302]).includes(foreign.status) && !/Closure Activity|m2d1-canary/i.test(foreign.body),
  status: foreign.status,
  duration_ms: Math.round(foreign.durationMs * 100) / 100,
});

const post = await request(closurePath, { method: "POST", body: "m2d1-canary" });
checks.push({
  name: "closure rejects mutation method",
  expected_statuses: [405],
  passed: post.status === 405,
  status: post.status,
  duration_ms: Math.round(post.durationMs * 100) / 100,
});

const load = summarize(closureResults);
const report = {
  schema: "artflow.m2-d1.result-closure-rehearsal.v1",
  base_url: baseUrl,
  activity_id: Number(activityId),
  bounds: {
    request_timeout_ms: timeoutMs,
    total_requests: requestCount + 3,
    max_concurrency: concurrency,
    public_network: false,
    mutating_authority_requests: false,
  },
  metrics: {
    total_requests: requestCount + 3,
    concurrency,
    p50_ms: load.p50_ms,
    p95_ms: load.p95_ms,
    p99_ms: load.p99_ms,
    timeout_count: load.timeout_count,
    status_2xx: load.status_counts["200"] ?? 0,
    status_4xx: Object.entries(load.status_counts)
      .filter(([status]) => /^4\d\d$/.test(status))
      .reduce((total, [, count]) => total + count, 0),
    status_5xx: load.server_error_count,
    duplicate_confirm_count: 0,
    stale_rejection_count: 0,
    cross_activity_rejection_count: foreign.status === 404 || (!staffCookie && foreign.status === 302) ? 1 : 0,
    token_secret_leakage_count: load.token_secret_leakage_count,
    official_source_leakage_count: 0,
  },
  not_exercised_by_read_only_script: [
    "duplicate confirm POST",
    "stale result rejection",
    "official-source export leakage",
    "PostgreSQL row-lock race",
  ],
  checks,
};
console.log(JSON.stringify(report, null, 2));

if (
  checks.some((check) => !check.passed)
  || load.timeout_count > 0
  || load.server_error_count > 0
  || load.token_secret_leakage_count > 0
) {
  process.exitCode = 1;
}
