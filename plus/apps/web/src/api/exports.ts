import { apiFetch } from "./client.js";

export type ExportFormat = "csv" | "docx" | "xlsx";

/** Formats this deployment can actually render; CSV is always available. */
export async function fetchExportFormats(): Promise<readonly ExportFormat[]> {
  const response = await apiFetch<{ formats: readonly ExportFormat[] }>("/api/exports/formats");
  return response.formats;
}
