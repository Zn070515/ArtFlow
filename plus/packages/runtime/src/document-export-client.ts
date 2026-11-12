import { DomainError } from "@artflow-plus/domain";

import type { ExportCell } from "./export-service.js";

export type DocumentFormat = "docx" | "xlsx";

export interface DocumentRenderInput {
  readonly format: DocumentFormat;
  readonly title: string;
  readonly filenameStem: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly ExportCell[])[];
}

export interface RenderedDocument {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly extension: DocumentFormat;
}

/** Outbound seam; the API route never talks HTTP to the renderer directly. */
export interface DocumentExporter {
  render(input: DocumentRenderInput): Promise<RenderedDocument>;
}

export const DOCUMENT_CONTENT_TYPES: Readonly<Record<DocumentFormat, string>> = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export interface HttpDocumentExporterOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function unavailable(reason: string): DomainError {
  return new DomainError("EXPORT_UNAVAILABLE", `The document export service is unavailable. ${reason}`);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw unavailable("The rendered document exceeded the response limit.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export function createHttpDocumentExporter(
  options: HttpDocumentExporterOptions,
): DocumentExporter {
  // Strip trailing slashes without a regex: a trailing-anchor pattern is a
  // CodeQL polynomial-ReDoS false positive, and the loop is exact.
  let baseUrl = options.baseUrl;
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    async render(input) {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/v1/render`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-artflow-export-token": options.token,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw unavailable("The renderer did not answer.");
      }
      if (response.status === 413) {
        throw new DomainError("EXPORT_TOO_LARGE", "The export is too large for the renderer.");
      }
      if (response.status === 400) {
        throw new DomainError("EXPORT_INVALID", "The renderer rejected the export payload.");
      }
      if (!response.ok) {
        throw unavailable(`The renderer returned ${response.status}.`);
      }
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (contentType !== DOCUMENT_CONTENT_TYPES[input.format]) {
        throw unavailable("The renderer returned an unexpected content type.");
      }
      let bytes: Buffer;
      try {
        bytes = await readCapped(response, maxBytes);
      } catch (error) {
        // A timeout or reset after the headers rejects mid-stream; it must
        // still fail closed as an unavailable renderer, not an internal error.
        if (error instanceof DomainError) throw error;
        throw unavailable("The renderer response could not be read.");
      }
      if (bytes.length === 0) throw unavailable("The renderer returned an empty document.");
      return { bytes, contentType, extension: input.format };
    },
  };
}

/** Configuration is the only place the sidecar address and token are read. */
export function createDocumentExporterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DocumentExporter | null {
  const baseUrl = env.ARTFLOW_PLUS_EXPORT_SERVICE_URL?.trim() ?? "";
  const token = env.ARTFLOW_PLUS_EXPORT_TOKEN?.trim() ?? "";
  if ((baseUrl === "") !== (token === "")) {
    throw new Error(
      "ARTFLOW_PLUS_EXPORT_SERVICE_URL and ARTFLOW_PLUS_EXPORT_TOKEN must be set together.",
    );
  }
  if (baseUrl === "") return null;
  return createHttpDocumentExporter({
    baseUrl,
    token,
    timeoutMs: positiveInteger(env.ARTFLOW_PLUS_EXPORT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxBytes: positiveInteger(env.ARTFLOW_PLUS_EXPORT_MAX_BYTES, DEFAULT_MAX_BYTES),
  });
}
