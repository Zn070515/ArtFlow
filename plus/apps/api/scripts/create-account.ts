import { closeDb, createDb, getLocalAccount, insertLocalAccount, migrate } from "@artflow-plus/db";
import { hashPassword } from "@artflow-plus/runtime";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const username = argument("--username");
const password = process.env.ARTFLOW_PLUS_ACCOUNT_PASSWORD ?? argument("--password");
if (username === undefined || username.trim() === "" || password === undefined || password.length < 8) {
  throw new Error("Usage: create-account --username <name> [--permissions a,b] [--roles admin] [--password <8+ chars>]");
}
const permissions = (argument("--permissions") ?? [
  "competition.manage",
  "competition.round.prepare",
  "competition.score.write",
  "registration.manage",
  "registration.review",
  "registration.roster.finalize",
  "studio.manage",
  "judge.manage",
  "result.manage",
  "voting.manage",
  "ticket.manage",
  "archive.manage",
  "materials.manage",
  "materials.read",
].join(",")).split(",").map((permission) => permission.trim()).filter(Boolean);
const roles = (argument("--roles") ?? "admin").split(",").map((role) => role.trim()).filter(Boolean);

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
}
const schema = process.env.ARTFLOW_PLUS_DB_SCHEMA;
const db = createDb({
  connectionString,
  ...(schema === undefined || schema === "" ? {} : { schema }),
});
await migrate(db);

const actorId = `user:${username.trim()}`;
const digest = hashPassword(password);
const existing = await getLocalAccount(db, username.trim());
if (existing === null) {
  await insertLocalAccount(db, {
    username: username.trim(),
    passwordDigest: digest,
    actor: {
      actorId,
      actorType: "user",
      roles,
      permissions,
    },
    active: true,
  });
  console.log(`Created account ${username}.`);
} else {
  await db.updateTable("local_account").set({
    password_digest: digest,
    actor_id: actorId,
    actor_type: "user",
    roles: JSON.stringify(roles),
    permissions: JSON.stringify(permissions),
    active: true,
  }).where("username", "=", username.trim()).execute();
  console.log(`Updated account ${username}.`);
}

await closeDb(db);
