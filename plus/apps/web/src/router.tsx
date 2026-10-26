import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { Landing } from "./routes/index.js";
import { JoinPage } from "./routes/join.js";
import { JoinActivityPage } from "./routes/joinActivity.js";
import { LoginPage } from "./routes/login.js";
import { OpsPage } from "./routes/ops.js";
import { ResultsRoute } from "./routes/results.js";
import { RootLayout } from "./routes/__root.js";

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

const opsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ops",
  component: OpsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  resultsRoute,
  loginRoute,
  joinRoute,
  joinActivityRoute,
  opsRoute,
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
