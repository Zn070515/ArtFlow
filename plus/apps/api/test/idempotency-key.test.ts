import type { Database } from "@artflow-plus/db";
import { CommandIdConflictError, StaleRevisionError } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import { CompositionError } from "@artflow-plus/runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  errorCode,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  isDriverErrorCode,
  requireIdempotency,
} from "../src/http/helpers.js";

function requestWithKey(key: unknown): FastifyRequest {
  return { headers: { "idempotency-key": key } } as unknown as FastifyRequest;
}

function driverError(): Error {
  const error = new Error("value too long for type character varying(100)");
  Object.assign(error, { code: "22001" });
  return error;
}

describe("idempotency key boundary", () => {
  it("trims a key at the receipt column length and rejects a longer one", () => {
    const max = "x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(requireIdempotency(requestWithKey(`  ${max}  `))).toBe(max);
    expect(requireIdempotency({ headers: { "idempotency-key": ["  ok  ", "ignored"] } } as unknown as FastifyRequest)).toBe("ok");

    expect(() => requireIdempotency(requestWithKey("   "))).toThrow(DomainError);
    expect(() => requireIdempotency(requestWithKey(undefined))).toThrow(DomainError);

    try {
      requireIdempotency(requestWithKey("x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)));
      throw new Error("expected a long Idempotency-Key to be refused");
    } catch (error) {
      expect(error).toMatchObject({ name: "DomainError", code: "INVALID_INPUT" });
      const message = error instanceof Error ? error.message : "";
      expect(message).toBe(`Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`);
      expect(message).not.toMatch(/22001|character varying|varchar|postgres/i);
    }
  });

  it("does not treat a PostgreSQL SQLSTATE as a domain code", () => {
    expect(isDriverErrorCode("22001")).toBe(true);
    expect(isDriverErrorCode("INVALID_INPUT")).toBe(false);
    expect(errorCode(driverError())).toBeNull();
    expect(errorCode({ code: "22001", message: "value too long for type character varying(100)" })).toBeNull();
    expect(errorCode(new DomainError("FORBIDDEN", "Permission studio.manage is required."))).toBe("FORBIDDEN");
    expect(errorCode(new StaleRevisionError("act"))).toBe("STALE_REVISION");
    expect(errorCode(new CommandIdConflictError("cmd"))).toBe("COMMAND_ID_CONFLICT");
    expect(errorCode(new CompositionError([]))).toBe("COMPOSITION_INVALID");
  });
});

describe("idempotency key HTTP response", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ db: {} as Kysely<Database> });
    app.post("/api/test/driver-error", async () => {
      throw driverError();
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns INVALID_INPUT for a 120-character Idempotency-Key and hides the schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/activities",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "x".repeat(120),
      },
      payload: { title: "too long", scope: "judging" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { code?: string; message?: string };
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.message).toBe("Idempotency-Key must be at most 100 characters.");
    expect(JSON.stringify(body)).not.toMatch(/22001|character varying|varchar|postgres/i);
  });

  it("replaces a raw database error with INTERNAL_ERROR", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/test/driver-error",
      headers: { "idempotency-key": "driver-error" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    });
    expect(response.body).not.toMatch(/22001|character varying|varchar|postgres/i);
  });
});
