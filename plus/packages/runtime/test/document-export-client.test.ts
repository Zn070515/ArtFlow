import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDocumentExporterFromEnv,
  createHttpDocumentExporter,
  DOCUMENT_CONTENT_TYPES,
  type DocumentRenderInput,
} from "../src/document-export-client.js";

const input: DocumentRenderInput = {
  format: "docx",
  title: "Export Activity",
  filenameStem: "activity-act_1-registrations",
  headers: ["participantId", "name"],
  rows: [["p-1", "Alice"]],
};

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => resolve(body));
  });
}

describe("HTTP document exporter", () => {
  it("sends the table and shared token, then returns validated bytes", async () => {
    let received = "";
    let token = "";
    const baseUrl = await serve(async (request, response) => {
      received = await readBody(request);
      token = String(request.headers["x-artflow-export-token"] ?? "");
      response.writeHead(200, { "content-type": DOCUMENT_CONTENT_TYPES.docx });
      response.end(Buffer.from("docx-bytes"));
    });
    const exporter = createHttpDocumentExporter({ baseUrl, token: "shared-secret" });
    const rendered = await exporter.render(input);
    expect(rendered.bytes.toString()).toBe("docx-bytes");
    expect(rendered.extension).toBe("docx");
    expect(token).toBe("shared-secret");
    expect(JSON.parse(received)).toEqual(input);
  });

  it("fails closed on a non-2xx answer", async () => {
    const baseUrl = await serve((_request, response) => {
      // A 500 that still looks like a document must not slip through the
      // content-type check; the status check has to reject it first.
      response.writeHead(500, { "content-type": DOCUMENT_CONTENT_TYPES.docx });
      response.end(Buffer.from("error-page"));
    });
    const exporter = createHttpDocumentExporter({ baseUrl, token: "shared-secret" });
    await expect(exporter.render(input)).rejects.toMatchObject({ code: "EXPORT_UNAVAILABLE" });
  });

  it("fails closed on an unexpected content type", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html></html>");
    });
    const exporter = createHttpDocumentExporter({ baseUrl, token: "shared-secret" });
    await expect(exporter.render(input)).rejects.toMatchObject({ code: "EXPORT_UNAVAILABLE" });
  });

  it("fails closed when the response exceeds the byte ceiling", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { "content-type": DOCUMENT_CONTENT_TYPES.docx });
      response.end(Buffer.alloc(64));
    });
    const exporter = createHttpDocumentExporter({ baseUrl, token: "shared-secret", maxBytes: 8 });
    await expect(exporter.render(input)).rejects.toMatchObject({ code: "EXPORT_UNAVAILABLE" });
  });

  it("reports a sidecar 413 as too large", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(413).end();
    });
    const exporter = createHttpDocumentExporter({ baseUrl, token: "shared-secret" });
    await expect(exporter.render(input)).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
  });

  it("reports a sidecar 400 as an invalid payload", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(400).end();
    });
    const exporter = createHttpDocumentExporter({ baseUrl, token: "shared-secret" });
    await expect(exporter.render(input)).rejects.toMatchObject({ code: "EXPORT_INVALID" });
  });

  it("fails closed when the body read fails after the headers", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { "content-type": DOCUMENT_CONTENT_TYPES.docx });
      response.write(Buffer.from("partial"));
      setTimeout(() => response.destroy(), 50);
    });
    const exporter = createHttpDocumentExporter({ baseUrl, token: "shared-secret", timeoutMs: 10 });
    await expect(exporter.render(input)).rejects.toMatchObject({ code: "EXPORT_UNAVAILABLE" });
  });

  it("refuses a half-configured exporter instead of silently disabling it", () => {
    expect(() => createDocumentExporterFromEnv({
      ARTFLOW_PLUS_EXPORT_SERVICE_URL: "http://127.0.0.1:1",
    })).toThrow(/must be set together/);
    expect(() => createDocumentExporterFromEnv({
      ARTFLOW_PLUS_EXPORT_TOKEN: "shared-secret",
    })).toThrow(/must be set together/);
    expect(createDocumentExporterFromEnv({})).toBeNull();
  });

  it("fails closed when the renderer does not answer in time", async () => {
    const baseUrl = await serve((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": DOCUMENT_CONTENT_TYPES.docx });
        response.end(Buffer.from("late"));
      }, 200);
    });
    const exporter = createHttpDocumentExporter({ baseUrl, token: "shared-secret", timeoutMs: 10 });
    await expect(exporter.render(input)).rejects.toMatchObject({ code: "EXPORT_UNAVAILABLE" });
  });
});
