import { createRealtimeClient } from "@artflow-plus/realtime/client";
import type { RealtimeClient } from "@artflow-plus/realtime/client";

let client: RealtimeClient | null = null;

export function getRealtimeClient(): RealtimeClient {
  client ??= createRealtimeClient({ url: "/api/realtime" });
  return client;
}
