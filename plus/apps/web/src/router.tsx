import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from "@tanstack/react-router";
import type { ErrorRouteComponent, RouteComponent } from "@tanstack/react-router";

import { RootLayout } from "./routes/__root.js";
import { RouteError, RoutePending } from "./components/shell/RouteError.js";

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./routes/index.js"), "Landing"),
});

const resultsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/results/$publicCode",
  component: lazyRouteComponent(() => import("./routes/results.js"), "ResultsRoute"),
});

const programRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/program/$publicCode",
  component: lazyRouteComponent(() => import("./routes/program.js"), "ProgramPage"),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  component: lazyRouteComponent(() => import("./routes/login.js"), "LoginPage"),
});

const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join",
  component: lazyRouteComponent(() => import("./routes/join.js"), "JoinPage"),
});

const joinActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join/$publicCode",
  component: lazyRouteComponent(() => import("./routes/joinActivity.js"), "JoinActivityPage"),
});

const opsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ops",
  component: lazyRouteComponent(() => import("./routes/ops.js"), "OpsPage"),
});

const opsActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ops/$activityId",
  component: lazyRouteComponent(() => import("./routes/opsActivity.js"), "OpsActivityPage"),
});

const opsRegistrationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ops/$activityId/registrations/$registrationId",
  component: lazyRouteComponent(() => import("./routes/opsRegistration.js"), "OpsRegistrationPage"),
});

const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio",
  component: lazyRouteComponent(() => import("./routes/studio.js"), "StudioPage"),
});

const studioNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/new",
  component: lazyRouteComponent(() => import("./routes/studioNew.js"), "StudioNewPage"),
});

const studioActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/$activityId",
  component: lazyRouteComponent(() => import("./routes/studioActivity.js"), "StudioActivityPage"),
});

const liveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/live",
  component: lazyRouteComponent(() => import("./routes/live.js"), "LivePage"),
});

const liveActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/live/$activityId",
  component: lazyRouteComponent(() => import("./routes/liveActivity.js"), "LiveActivityPage"),
});

const voteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vote/$sessionId",
  component: lazyRouteComponent(() => import("./routes/vote.js"), "VotePage"),
});

const judgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/judge/$publicCode",
  validateSearch: (search: Record<string, unknown>) => ({
    capability: typeof search.capability === "string" ? search.capability : undefined,
  }),
  component: lazyRouteComponent(() => import("./routes/judge.js"), "JudgePage"),
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspace",
  component: lazyRouteComponent(() => import("./routes/workspace.js"), "WorkspacePage"),
});

const workspaceActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspace/$activityId",
  component: lazyRouteComponent(() => import("./routes/workspaceActivity.js"), "WorkspaceActivityPage"),
});

const tokensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/_tokens",
  component: lazyRouteComponent(() => import("./routes/tokens.js"), "TokensPage"),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  resultsRoute,
  programRoute,
  loginRoute,
  joinRoute,
  joinActivityRoute,
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
  workspaceRoute,
  workspaceActivityRoute,
  tokensRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  // The runtime components are ordinary functions; the router types model
  // them as lazy route components. Their props are still checked by
  // ErrorComponentProps / RouteComponent at the component definition.
  defaultErrorComponent: RouteError as unknown as ErrorRouteComponent,
  defaultPendingComponent: RoutePending as unknown as RouteComponent,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
