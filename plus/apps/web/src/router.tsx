import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { Landing } from "./routes/index.js";
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

const routeTree = rootRoute.addChildren([indexRoute, resultsRoute]);

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
