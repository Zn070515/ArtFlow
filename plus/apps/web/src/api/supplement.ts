import { apiFetch } from "./client.js";

export interface SupplementCheckView {
  readonly slotKey: string;
  readonly itemName: string;
  readonly purpose: string;
  readonly status: string;
  readonly required: boolean;
  readonly reviewNote: string;
}

export interface SupplementMaterialView {
  readonly id: string;
  readonly questionKey: string;
  readonly originalName: string;
  readonly contentReady: boolean;
}

export interface SupplementContextView {
  readonly activity: { readonly publicCode: string; readonly title: string };
  readonly registrationId: string;
  readonly status: string;
  readonly allowedKeys: readonly string[];
  readonly checks: readonly SupplementCheckView[];
  readonly materials: readonly SupplementMaterialView[];
}

export function claimSupplement(token: string): Promise<SupplementContextView> {
  return apiFetch<SupplementContextView>("/api/public/supplement/claim", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function fetchSupplementContext(): Promise<SupplementContextView> {
  return apiFetch<SupplementContextView>("/api/public/supplement/context");
}

export function uploadSupplementMaterial(
  questionKey: string,
  file: File,
): Promise<unknown> {
  const params = new URLSearchParams({ name: file.name, type: file.type || "application/octet-stream" });
  return apiFetch(
    `/api/public/supplement/materials/${encodeURIComponent(questionKey)}/content?${params.toString()}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": crypto.randomUUID(),
      },
      body: file,
    },
  );
}

export function submitSupplement(): Promise<unknown> {
  return apiFetch("/api/public/supplement/submit", {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: "{}",
  });
}
