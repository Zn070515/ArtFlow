#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

const baseUrl = (process.env.ARTFLOW_REHEARSAL_BASE_URL ?? "http://127.0.0.1:18000").replace(/\/$/, "");
const requestTimeoutMs = 5000;
const healthzRequestCount = 320;
const healthzConcurrency = 32;
const anonymousContextRequestCount = 40;
const anonymousContextConcurrency = 8;
const authorizedFanoutRequestsPerSession = 20;
const authorizedFanoutConcurrency = 6;
const singleSessionQuotaRequests = 50;
const singleSessionQuotaConcurrency = 10;
const scoreProbeRequestCount = 64;
const scoreProbeConcurrency = 16;

if (process.argv.length < 9) {
  console.error(
    "Usage: node scripts/m2_c_malicious_rehearsal.mjs <fanout-fixture>... <quota-fixture>",
  );
  process.exit(2);
}

const fixturePaths = process.argv.slice(2);
const quotaFixturePath = fixturePaths.at(-1);
const fanoutFixturePaths = fixturePaths.slice(0, -1);
if (fanoutFixturePaths.length !== authorizedFanoutConcurrency) {
  console.error(`Expected ${authorizedFanoutConcurrency + 1} fixture paths.`);
  process.exit(2);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(label, results, startedAt) {
  const durations = results.map((result) => result.durationMs).sort((left, right) => left - right);
  const statusCounts = {};
  let errorCount = 0;
  for (const result of results) {
    const key = result.error ? "error" : String(result.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    if (result.error) errorCount += 1;
  }
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  return {
    label,
    requests: results.length,
    status_counts: statusCounts,
    errors: errorCount,
    p50_ms: Math.round(percentile(durations, 0.5) * 100) / 100,
    p95_ms: Math.round(percentile(durations, 0.95) * 100) / 100,
    p99_ms: Math.round(percentile(durations, 0.99) * 100) / 100,
    max_ms: Math.round(Math.max(...durations) * 100) / 100,
    wall_ms: durationMs,
    requests_per_second: Math.round((results.length / (durationMs / 1000)) * 100) / 100,
  };
}

async function request(path, options = {}) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      durationMs: performance.now() - startedAt,
      body: text.slice(0, 2000),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.name : "request-error",
      durationMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runLoad(label, count, concurrency, requestFactory) {
  const results = [];
  let nextIndex = 0;
  const startedAt = performance.now();
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= count) return;
      results[index] = await requestFactory(index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return summarize(label, results, startedAt);
}

function jsonRequest(body, headers = {}) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function readFixture(path) {
  const fixture = JSON.parse(await readFile(path, "utf8"));
  if (typeof fixture.grant_token !== "string" || fixture.grant_token.length < 20) {
    throw new Error(`Fixture ${path} does not contain a valid grant token.`);
  }
  return fixture.grant_token;
}

async function redeemFixture(path) {
  const token = await readFixture(path);
  const response = await request(
    "/entry-access/grants/redeem/",
    jsonRequest({ token }),
  );
  if (response.status !== 200) {
    throw new Error(`Fixture redemption failed with HTTP ${response.status}.`);
  }
  const payload = JSON.parse(response.body);
  if (typeof payload.session_token !== "string" || payload.session_token.length < 20) {
    throw new Error("Fixture redemption did not return a session token.");
  }
  return payload.session_token;
}

const protocolResults = [];
protocolResults.push({
  name: "healthz rejects POST",
  response: await request("/healthz/", { method: "POST" }),
  expected: 405,
});
protocolResults.push({
  name: "redeem rejects GET",
  response: await request("/entry-access/grants/redeem/"),
  expected: 405,
});
protocolResults.push({
  name: "score rejects cross-origin bearer",
  response: await request(
    "/judge/score/",
    jsonRequest({}, { Authorization: "Bearer m2c-probe-cross-origin", Origin: "https://evil.example" }),
  ),
  expected: 403,
});
protocolResults.push({
  name: "score rejects malformed JSON",
  response: await request("/judge/score/", {
    method: "POST",
    headers: {
      Authorization: "Bearer m2c-probe-malformed",
      "Content-Type": "application/json",
    },
    body: "{",
  }),
  expected: 400,
});
protocolResults.push({
  name: "score rejects oversized body",
  response: await request("/judge/score/", {
    method: "POST",
    headers: {
      Authorization: "Bearer m2c-probe-oversized",
      "Content-Type": "application/json",
    },
    body: `{"oversized":"${"x".repeat(17 * 1024)}"}`,
  }),
  expected: 413,
});

const anonymousContext = await runLoad(
  "anonymous judge context scan",
  anonymousContextRequestCount,
  anonymousContextConcurrency,
  () => request("/judge/context/"),
);

const scoreProbe = await runLoad(
  "cross-origin score probe burst",
  scoreProbeRequestCount,
  scoreProbeConcurrency,
  (index) =>
    request(
      "/judge/score/",
      jsonRequest(
        {},
        {
          Authorization: `Bearer m2c-probe-burst-${index}`,
          Origin: "https://evil.example",
        },
      ),
    ),
);

const healthz = await runLoad(
  "healthz bounded load",
  healthzRequestCount,
  healthzConcurrency,
  () => request("/healthz/"),
);

const fanoutSessions = [];
for (const fixturePath of fanoutFixturePaths) fanoutSessions.push(await redeemFixture(fixturePath));
const quotaSession = await redeemFixture(quotaFixturePath);

let fanoutIndex = 0;
const authorizedFanout = await runLoad(
  "six authorized judge sessions on one source IP",
  fanoutSessions.length * authorizedFanoutRequestsPerSession,
  authorizedFanoutConcurrency,
  () => {
    const session = fanoutSessions[fanoutIndex % fanoutSessions.length];
    fanoutIndex += 1;
    return request("/judge/context/", { headers: { Authorization: `Bearer ${session}` } });
  },
);

const singleSessionQuota = await runLoad(
  "single authorized session quota",
  singleSessionQuotaRequests,
  singleSessionQuotaConcurrency,
  () => request("/judge/context/", { headers: { Authorization: `Bearer ${quotaSession}` } }),
);

const protocolSummary = protocolResults.map(({ name, response, expected }) => ({
  name,
  expected,
  actual: response.status ?? "error",
  duration_ms: Math.round(response.durationMs * 100) / 100,
  passed: response.status === expected,
  body_contains_canary: /m2c-probe|m2c-canary/.test(response.body ?? ""),
}));

console.log(
  JSON.stringify(
    {
      schema: "artflow.m2-c.malicious-rehearsal.v1",
      base_url: baseUrl,
      bounds: {
        request_timeout_ms: requestTimeoutMs,
        max_concurrency: Math.max(
          healthzConcurrency,
          anonymousContextConcurrency,
          scoreProbeConcurrency,
          authorizedFanoutConcurrency,
          singleSessionQuotaConcurrency,
        ),
        public_network: false,
        mutating_authority_requests: false,
      },
      protocol_probes: protocolSummary,
      loads: [anonymousContext, scoreProbe, healthz, authorizedFanout, singleSessionQuota],
    },
    null,
    2,
  ),
);

if (protocolSummary.some((probe) => !probe.passed || probe.body_contains_canary)) process.exitCode = 1;
