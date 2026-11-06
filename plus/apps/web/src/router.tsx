import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { Landing } from "./routes/index.js";
import { JoinPage } from "./routes/join.js";
import { JoinActivityPage } from "./routes/joinActivity.js";
import { JudgePage } from "./routes/judge.js";
import { ClaimPage } from "./routes/claim.js";
import { LivePage } from "./routes/live.js";
import { LiveActivityPage } from "./routes/liveActivity.js";
import { LoginPage } from "./routes/login.js";
import { OpsPage } from "./routes/ops.js";
import { OpsActivityPage } from "./routes/opsActivity.js";
import { OpsRegistrationPage } from "./routes/opsRegistration.js";
import { ResultsRoute } from "./routes/results.js";
import { RootLayout } from "./routes/__root.js";
import { StudioPage } from "./routes/studio.js";
import { StudioActivityPage } from "./routes/studioActivity.js";
import { StudioNewPage } from "./routes/studioNew.js";
import { VotePage } from "./routes/vote.js";

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Landing,
});

const resultsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/results/$publicCode",
  component: ResultsRoute,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  component: LoginPage,
});

const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join",
  component: JoinPage,
});

const joinActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join/$publicCode",
  component: JoinActivityPage,
});

const claimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/claim",
  component: ClaimPage,
});

const opsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ops",
  component: OpsPage,
});

const opsActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ops/$activityId",
  component: OpsActivityPage,
});

const opsRegistrationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ops/$activityId/registrations/$registrationId",
  component: OpsRegistrationPage,
});

const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio",
  component: StudioPage,
});

const studioNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/new",
  component: StudioNewPage,
});

const studioActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/$activityId",
  component: StudioActivityPage,
});

const liveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/live",
  component: LivePage,
});

const liveActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/live/$activityId",
  component: LiveActivityPage,
});

const voteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vote/$sessionId",
  component: VotePage,
});

const judgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/judge/$publicCode",
  validateSearch: (search: Record<string, unknown>) => ({
    capability: typeof search.capability === "string" ? search.capability : undefined,
  }),
  component: JudgePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  resultsRoute,
  loginRoute,
  joinRoute,
  joinActivityRoute,
  claimRoute,
  opsRoute,
  opsActivityRoute,
  opsRegistrationRoute,
  studioRoute,
  studioNewRoute,
  studioActivityRoute,
  liveRoute,
  liveActivityRoute,
  voteRoute,
  judgeRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
