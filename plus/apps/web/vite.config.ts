import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3000";
const proxy = {
  "/api": { target: apiTarget, changeOrigin: true, ws: true },
};

// The production edge adds the full policy (including CSP and HSTS). The dev
// and preview servers still get the baseline headers so a direct local run is
// not a silent downgrade. CSP is omitted here because Vite's HMR needs inputs
// the production bundle does not.
const securityHeaders = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy, headers: securityHeaders },
  preview: { port: 4173, proxy, headers: securityHeaders },
});
