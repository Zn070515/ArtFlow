#!/usr/bin/env node

// Media download load rehearsal.
//
// `controlled_media` authorizes a private path and then streams the bytes through the
// Gunicorn worker handling that request (`common/delivery.py`, `LocalFilesystemDelivery`).
// There is no separate file service and no `X-Accel-Redirect`. With the shipped worker
// pool (Dockerfile: `--workers 3`), concurrent *slow* downloads are therefore a capacity
// failure mode: each one pins a worker for the whole transfer, and client back-pressure —
// a phone on venue wifi — is what keeps it pinned.
//
// This script produces the evidence the production doc asks for. It:
//
//   * measures `/livez/` latency on an independent connection while N clients download,
//     so "the app stopped answering" is a number rather than an intuition,
//   * keeps every download authorized through the real gateway, and
//   * re-checks, *while the workers are saturated*, that an unauthenticated request to
//     the same path still fails closed. That is the correctness half: moving bytes off
//     the worker later must not move authorization off it.
//
// The starvation number is a measurement, not a gate: today the expected result is that
// it starves, and the point is to decide the fix on data rather than on a hunch. The
// authorization check *is* a hard check, and a failure exits non-zero.

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const fixturePath = process.env.ARTFLOW_MEDIA_LOAD_FIXTURE_PATH;
if (!fixturePath) throw new Error("ARTFLOW_MEDIA_LOAD_FIXTURE_PATH is required.");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

const rawBaseUrl = process.env.ARTFLOW_REHEARSAL_BASE_URL ?? "http://127.0.0.1:8000";
const base = new URL(rawBaseUrl);
const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
if (base.protocol !== "http:" || !allowedHosts.has(base.hostname)) {
  throw new Error("This rehearsal only accepts an HTTP service on localhost/127.0.0.1/::1.");
}
const baseUrl = rawBaseUrl.replace(/\/$/, "");

const clients = Number(process.env.ARTFLOW_MEDIA_LOAD_CLIENTS ?? 3);
const durationMs = Number(process.env.ARTFLOW_MEDIA_LOAD_DURATION_MS ?? 10000);
const clientPauseMs = Number(process.env.ARTFLOW_MEDIA_LOAD_CLIENT_PAUSE_MS ?? 50);
const probeIntervalMs = Number(process.env.ARTFLOW_MEDIA_LOAD_PROBE_INTERVAL_MS ?? 250);
const probeTimeoutMs = Number(process.env.ARTFLOW_MEDIA_LOAD_PROBE_TIMEOUT_MS ?? 5000);

if (!Number.isInteger(clients) || clients < 1 || clients > 64) {
  throw new Error("ARTFLOW_MEDIA_LOAD_CLIENTS must be an integer between 1 and 64.");
}
if (durationMs > 120000) {
  throw new Error("ARTFLOW_MEDIA_LOAD_DURATION_MS is capped at 120000 for a bounded run.");
}

const mediaUrl = `${baseUrl}${fixture.media_url_path}`;

async function timedFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return {
      status: response.status,
      response,
      durationMs: performance.now() - startedAt,
      timedOut: false,
    };
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    return { status: 0, response: null, durationMs: performance.now() - startedAt, timedOut: true };
  } finally {
    clearTimeout(timer);
  }
}

async function probe() {
  const result = await timedFetch(`${baseUrl}/livez/`, {}, probeTimeoutMs);
  if (result.response) await result.response.arrayBuffer();
  return { durationMs: result.durationMs, ok: result.status === 200, timedOut: result.timedOut };
}

// One simulated reader: read a chunk, then pause. The pause is the whole point — a
// loopback client with no pause drains the file in milliseconds and never holds a worker.
async function download(index, stopAt) {
  const startedAt = performance.now();
  let bytes = 0;
  const controller = new AbortController();
  try {
    const response = await fetch(mediaUrl, {
      headers: { Cookie: fixture.session_cookie },
      signal: controller.signal,
    });
    if (!response.body) {
      return { index, status: response.status, bytes, durationMs: performance.now() - startedAt };
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (performance.now() >= stopAt) {
        controller.abort();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, clientPauseMs));
    }
    return { index, status: response.status, bytes, durationMs: performance.now() - startedAt };
  } catch (error) {
    return {
      index,
      status: 0,
      bytes,
      durationMs: performance.now() - startedAt,
      error: String(error).slice(0, 80),
    };
  }
}

function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
}

const baseline = [];
for (let index = 0; index < 5; index += 1) baseline.push(await probe());

const probes = [];
let authorizationWhileStarved = null;
const stopAt = performance.now() + durationMs;
const downloads = Array.from({ length: clients }, (_, index) => download(index, stopAt));

const probeTimer = setInterval(() => {
  void probe().then((result) => probes.push(result));
}, probeIntervalMs);

// The authorization check has to run *while* the workers are occupied, otherwise it
// proves nothing about the saturated path.
const unauthorized = await timedFetch(mediaUrl, {}, probeTimeoutMs);
authorizationWhileStarved = {
  status: unauthorized.status,
  timedOut: unauthorized.timedOut,
  durationMs: Math.round(unauthorized.durationMs),
};

const results = await Promise.all(downloads);
clearInterval(probeTimer);
await new Promise((resolve) => setTimeout(resolve, probeIntervalMs));

const succeeded = probes.filter((entry) => entry.ok);
// Aggregate over every probe, counting a timeout as the timeout it was: dropping the
// timed-out probes would report the fastest half of a stalled period as if it were typical.
const latencies = probes
  .map((entry) => (entry.timedOut ? probeTimeoutMs : entry.durationMs))
  .sort((a, b) => a - b);
const timedOutProbes = probes.filter((entry) => entry.timedOut).length;
const slowProbes = probes.filter((entry) => !entry.timedOut && entry.durationMs > 1000).length;
const p95 = percentile(latencies, 0.95);
const starved = timedOutProbes > 0 || (p95 ?? 0) > 1000;

// Hard correctness checks. Authorization is the invariant: an unauthenticated caller must
// never be *served* the bytes. A timeout is the starvation this rehearsal measures, not a
// bypass — when every worker is occupied the request is never even accepted, so there is no
// 403 to observe. Serving a 2xx is the failure.
const failedChecks = [];
for (const result of results) {
  if (result.status !== 200) failedChecks.push(`download ${result.index} returned ${result.status}`);
}
const unauthenticatedServed =
  authorizationWhileStarved.status >= 200 && authorizationWhileStarved.status < 300;
if (unauthenticatedServed) {
  failedChecks.push(
    `unauthenticated download was served (status ${authorizationWhileStarved.status})`
  );
}

const report = {
  base_url: baseUrl,
  clients,
  duration_ms: durationMs,
  client_pause_ms: clientPauseMs,
  payload_size_bytes: fixture.size_bytes,
  baseline_livez_ms: baseline.map((entry) => Math.round(entry.durationMs)),
  downloads: results.map((entry) => ({
    index: entry.index,
    status: entry.status,
    bytes: entry.bytes,
    duration_ms: Math.round(entry.durationMs),
  })),
  probes_during_load: {
    count: probes.length,
    ok: succeeded.length,
    slow_over_1s: slowProbes,
    timed_out: timedOutProbes,
    p50_ms: percentile(latencies, 0.5),
    p95_ms: p95,
    p99_ms: percentile(latencies, 0.99),
    max_ms: latencies.length > 0 ? Math.round(latencies[latencies.length - 1]) : null,
  },
  workers_starved: starved,
  authorization_while_starved: authorizationWhileStarved,
  failed_checks: failedChecks,
  source_volumes_reset: false,
};

const reportPath = process.env.ARTFLOW_MEDIA_LOAD_REPORT_PATH;
if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(
  `baseline /livez/: ${report.baseline_livez_ms.join(", ")} ms` +
    ` | payload: ${(fixture.size_bytes / 1024 / 1024).toFixed(0)} MiB x ${clients} clients`
);
for (const entry of report.downloads) {
  console.log(
    `  download ${entry.index}: status=${entry.status} ` +
      `bytes=${entry.bytes} duration=${entry.duration_ms}ms`
  );
}
const during = report.probes_during_load;
console.log(
  `  /livez/ during load: n=${during.count} ok=${during.ok} slow>1s=${during.slow_over_1s} ` +
    `timed_out=${during.timed_out} p50=${during.p50_ms} p95=${during.p95_ms} ` +
    `p99=${during.p99_ms} max=${during.max_ms}`
);
const unauthorizedNote = authorizationWhileStarved.timedOut
  ? "timed out — no worker free to reject it, and no bytes served"
  : "rejected by the authorization gateway";
console.log(
  `  unauthenticated download while load was running: ` +
    `status=${authorizationWhileStarved.status} (${unauthorizedNote})`
);
console.log(`  workers_starved: ${starved}`);
console.log(`SUMMARY ${JSON.stringify(report)}`);

if (failedChecks.length > 0) {
  for (const failure of failedChecks) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
