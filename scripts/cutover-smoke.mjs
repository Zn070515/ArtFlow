// Read-only post-switch checks. Run with Node 24 on the host or through a
// one-shot node container; it never mutates data.
//
// Profiles:
//   historical  - the activity is an imported history record; public results
//                 must already exist.
//   operational - the activity is a current v1 activity adopted by Plus; there
//                 may be no published result yet, but it must have a real
//                 release, composition, and authority to run.
const base = process.env.CUTOVER_BASE_URL;
const publicCode = process.env.CUTOVER_PUBLIC_CODE;
const expectedTitle = process.env.CUTOVER_EXPECTED_TITLE ?? "";
const username = process.env.CUTOVER_STAFF_USER;
const password = process.env.CUTOVER_STAFF_PASSWORD;
const profile = process.env.CUTOVER_PROFILE ?? "historical";
const requiredCapabilities = (process.env.CUTOVER_REQUIRED_CAPABILITIES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!base || !publicCode) {
  throw new Error("CUTOVER_BASE_URL and CUTOVER_PUBLIC_CODE are required.");
}
if (profile !== "historical" && profile !== "operational") {
  throw new Error(`Unknown CUTOVER_PROFILE: ${profile}`);
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

async function staffToken() {
  const response = await fetch(`${base}/api/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`token status ${response.status}`);
  return (await response.json()).token;
}

async function activityByPublicCode(token) {
  const list = await fetch(`${base}/api/activities`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!list.ok) throw new Error(`activities status ${list.status}`);
  const body = await list.json();
  return (body.activities ?? []).find((activity) => activity.publicCode === publicCode);
}

await check("healthz", async () => {
  const response = await fetch(`${base}/healthz`);
  if (!response.ok) throw new Error(`status ${response.status}`);
});

await check("anonymous activities are rejected", async () => {
  const response = await fetch(`${base}/api/activities`);
  if (response.status !== 401) throw new Error(`status ${response.status}`);
});

if (profile === "historical") {
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

  if (username && password) {
    await check("staff login and activity list", async () => {
      const token = await staffToken();
      if (await activityByPublicCode(token) === undefined) {
        throw new Error("activity missing from the staff list");
      }
    });
  }
} else {
  if (!username || !password) {
    throw new Error("The operational profile needs CUTOVER_STAFF_USER and CUTOVER_STAFF_PASSWORD.");
  }

  await check("public activity exists and is active", async () => {
    const response = await fetch(`${base}/api/public/activities/${encodeURIComponent(publicCode)}`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body = await response.json();
    if (body.status !== "active") throw new Error(`status ${body.status}`);
    if (expectedTitle && body.title !== expectedTitle) throw new Error(`title ${body.title}`);
  });

  await check("staff can see the adopted activity", async () => {
    const token = await staffToken();
    const listed = await activityByPublicCode(token);
    if (listed === undefined) throw new Error("activity missing from the staff list");
  });

  await check("activity has an active released definition", async () => {
    const token = await staffToken();
    const listed = await activityByPublicCode(token);
    if (listed === undefined) throw new Error("activity missing from the staff list");
    const detail = await fetch(`${base}/api/activities/${listed.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!detail.ok) throw new Error(`detail status ${detail.status}`);
    const activity = await detail.json();
    if (!Array.isArray(activity.enabledCapabilities) || activity.enabledCapabilities.length === 0) {
      throw new Error("no enabled capabilities");
    }
    const missing = requiredCapabilities.filter((capability) => !activity.enabledCapabilities.includes(capability));
    if (missing.length > 0) throw new Error(`missing capabilities: ${missing.join(", ")}`);
    if (!(activity.activeDefinitionVersion > 0)) throw new Error("no active definition release");
  });

  await check("registration detail and material bridge are readable", async () => {
    const token = await staffToken();
    const listed = await activityByPublicCode(token);
    if (listed === undefined) throw new Error("activity missing from the staff list");
    const registrations = await fetch(`${base}/api/activities/${listed.id}/registrations`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!registrations.ok) throw new Error(`registrations status ${registrations.status}`);
    const body = await registrations.json();
    const first = (body.registrations ?? [])[0];
    if (first === undefined) return;
    const detail = await fetch(`${base}/api/activities/${listed.id}/registrations/${first.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!detail.ok) throw new Error(`registration detail status ${detail.status}`);
    const material = (await detail.json()).materials?.[0];
    if (material !== undefined) {
      const content = await fetch(
        `${base}/api/activities/${listed.id}/materials/${material.id}/content`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!content.ok) throw new Error(`material content status ${content.status}`);
      const bytes = await content.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error("material content is empty");
    }
  });

  await check("studio shows a frozen release with scopes and command ownership", async () => {
    const token = await staffToken();
    const listed = await activityByPublicCode(token);
    if (listed === undefined) throw new Error("activity missing from the staff list");
    const response = await fetch(`${base}/api/activities/${listed.id}/studio`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`studio status ${response.status}`);
    const state = await response.json();
    const active = (state.releases ?? []).filter((release) => release.active);
    if (active.length !== 1) throw new Error(`active releases: ${active.length}`);
    if (!Array.isArray(active[0].declaredScopes) || active[0].declaredScopes.length === 0) {
      throw new Error("the active release declares no scopes");
    }
    if (Object.keys(active[0].capabilityVersions ?? {}).length === 0) {
      throw new Error("the active release freezes no capability versions");
    }
    const commandScopes = active[0].commandScopes ?? {};
    if (!commandScopes["competition.round.prepare"] || !commandScopes["voting.ballot.submit"]) {
      throw new Error("the active release does not bind execution commands to scopes");
    }
  });
}

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`cutover smoke passed (${profile})`);
