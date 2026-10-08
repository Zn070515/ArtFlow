// The pages the phone audits walk, shared by the layout and touch-target specs so the
// two cannot drift apart. Add a page here and both measure it.
//
// The fixture comes from `python manage.py prepare_layout_e2e`; without it the staff
// pages are skipped and the public ones still run.

import { readFileSync } from "node:fs";

export type Fixture = {
  public_code: string;
  activity_id: number;
  round_id: number;
  singer_id: number;
  vote_session_id: number;
  session_key: string;
};

export type Target = { name: string; path: string; staff?: boolean };

export const PUBLIC_TARGETS: Target[] = [
  { name: "home", path: "/" },
  { name: "results", path: "/results/" },
  { name: "showcase", path: "/showcase/" },
  { name: "announcements", path: "/announcements/" },
  { name: "privacy", path: "/privacy/" },
  { name: "login", path: "/login/" },
  { name: "staff-login", path: "/login/staff/" },
  { name: "register", path: "/register/" },
];

export const FIXTURE_TARGETS: Target[] = [
  { name: "activity-entry", path: "/e/{code}/" },
  { name: "activity-live", path: "/e/{code}/live/" },
  { name: "activity-judge", path: "/e/{code}/judge/" },
  { name: "staff-dashboard", path: "/staff/", staff: true },
  { name: "staff-workspace", path: "/staff/activities/{activity}/workspace/", staff: true },
  { name: "staff-activities", path: "/staff/activities/", staff: true },
  { name: "staff-ruleset-templates", path: "/staff/ruleset-templates/", staff: true },
  { name: "staff-registrations", path: "/staff/registrations/", staff: true },
  { name: "staff-rounds", path: "/staff/rounds/", staff: true },
  { name: "staff-round-scores", path: "/staff/rounds/{round}/scores/", staff: true },
  { name: "staff-ticket-manage", path: "/staff/tickets/manage/", staff: true },
  { name: "staff-ticket-check-in", path: "/staff/tickets/check-in-page/", staff: true },
  { name: "staff-vote-sessions", path: "/staff/vote-sessions/", staff: true },
  { name: "staff-vote-session-detail", path: "/staff/vote-sessions/{vote}/", staff: true },
  { name: "staff-judges", path: "/staff/judges/", staff: true },
  { name: "staff-judge-control", path: "/staff/judges/round/{round}/control/", staff: true },
  { name: "staff-awards", path: "/staff/awards/", staff: true },
  { name: "staff-incidents", path: "/staff/incidents/", staff: true },
  { name: "staff-audit-logs", path: "/staff/audit-logs/", staff: true },
  { name: "staff-export-center", path: "/staff/export-center/", staff: true },
  { name: "staff-qr-center", path: "/staff/qr/", staff: true },
  { name: "staff-users", path: "/staff/users/", staff: true },
  { name: "staff-posts", path: "/staff/posts/", staff: true },
  { name: "staff-programs", path: "/staff/programs/", staff: true },
  { name: "staff-registration-detail", path: "/staff/registrations/{singer}/", staff: true },
  { name: "staff-activity-new", path: "/staff/activities/new/", staff: true },
  { name: "staff-activity-edit", path: "/staff/activities/{activity}/edit/", staff: true },
  { name: "staff-round-new", path: "/staff/rounds/new/", staff: true },
  { name: "staff-round-running-order", path: "/staff/rounds/{round}/running-order/", staff: true },
  { name: "staff-round-groups", path: "/staff/rounds/{round}/groups/", staff: true },
  { name: "staff-round-ranking", path: "/staff/rounds/{round}/ranking/", staff: true },
  { name: "staff-rubric-new", path: "/staff/rubrics/new/", staff: true },
  { name: "staff-vote-new", path: "/staff/vote-sessions/new/", staff: true },
  { name: "staff-judge-new", path: "/staff/judges/new/", staff: true },
  { name: "staff-ruleset-create", path: "/staff/rulesets/create/", staff: true },
  { name: "staff-result-board", path: "/staff/activity/{activity}/result-board/", staff: true },
  { name: "staff-result-closure", path: "/staff/activity/{activity}/result-closure/", staff: true },
  { name: "staff-audience-scores", path: "/staff/activity/{activity}/audience-scores/", staff: true },
];

export function loadFixture(): Fixture | null {
  const path = process.env.PLAYWRIGHT_LAYOUT_FIXTURE_PATH;
  return path ? (JSON.parse(readFileSync(path, "utf8")) as Fixture) : null;
}

export function makeResolver(fixture: Fixture | null) {
  return (path: string): string =>
    path
      .replace("{code}", fixture?.public_code ?? "")
      .replace("{activity}", String(fixture?.activity_id ?? ""))
      .replace("{round}", String(fixture?.round_id ?? ""))
      .replace("{vote}", String(fixture?.vote_session_id ?? ""))
      .replace("{singer}", String(fixture?.singer_id ?? ""));
}
