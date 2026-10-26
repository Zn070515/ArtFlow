import "@fontsource-variable/fraunces";
import "@fontsource-variable/space-grotesk";
import "./styles/tokens.css";
import "./styles/global.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SessionProvider } from "./auth/SessionProvider.js";
import { router } from "./router.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: false,
    },
  },
});

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
