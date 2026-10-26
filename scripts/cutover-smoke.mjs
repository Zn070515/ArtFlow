// Read-only post-switch checks. Run with Node 24 on the host or through a
// one-shot node container; it never mutates data.
const base = process.env.CUTOVER_BASE_URL;
const publicCode = process.env.CUTOVER_PUBLIC_CODE;
const expectedTitle = process.env.CUTOVER_EXPECTED_TITLE ?? "";
const username = process.env.CUTOVER_STAFF_USER;
const password = process.env.CUTOVER_STAFF_PASSWORD;

if (!base || !publicCode) {
  throw new Error("CUTOVER_BASE_URL and CUTOVER_PUBLIC_CODE are required.");
}

const failures = [];

async function check(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check("healthz", async () => {
  const response = await fetch(`${base}/healthz`);
  if (!response.ok) throw new Error(`status ${response.status}`);
});

await check("public results", async () => {
  const response = await fetch(`${base}/api/public/results/${encodeURIComponent(publicCode)}`);
  if (!response.ok) throw new Error(`status ${response.status}`);
  const body = await response.json();
  if (expectedTitle && body.activityTitle !== expectedTitle) {
    throw new Error(`title ${body.activityTitle}`);
  }
  if (!Array.isArray(body.results) || body.results.length === 0) {
    throw new Error("empty results");
  }
});

await check("anonymous activities are rejected", async () => {
  const response = await fetch(`${base}/api/activities`);
  if (response.status !== 401) throw new Error(`status ${response.status}`);
});

if (username && password) {
  await check("staff login and activity list", async () => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!login.ok) throw new Error(`login status ${login.status}`);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const activities = await fetch(`${base}/api/activities`, { headers: { cookie } });
    if (!activities.ok) throw new Error(`activities status ${activities.status}`);
  });
}

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("cutover smoke passed");
