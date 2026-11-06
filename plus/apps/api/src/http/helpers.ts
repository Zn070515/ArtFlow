import type { TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { FastifyRequest } from "fastify";

import { DomainError } from "@artflow-plus/domain";
import type { ActivityDefinitionPackage } from "@artflow-plus/domain";

import { isProductionEnvironment, sessionCookie } from "../cookies.js";

export function requireIdempotency(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("INVALID_INPUT", "An Idempotency-Key header is required.");
  }
  return value.trim();
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return undefined;
  const token = trimmed.slice("bearer ".length).trim();
  return token === "" ? undefined : token;
}

export function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Responses redact one-time fields; replay-aware services may restore them only for cookie setting. */
export function sessionTokenValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type ClosedSchemaValidationError = {
  readonly keyword: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly params: Record<string, unknown>;
  readonly message?: string;
};

export type ClosedSchemaValidator = ((data: unknown) => boolean) & {
  errors?: ClosedSchemaValidationError[] | null;
};

export function compileClosedTypeBoxSchema({ schema }: { readonly schema: unknown }): ClosedSchemaValidator {
  const checker = TypeCompiler.Compile(schema as TSchema);
  const validate = ((data: unknown): boolean => {
    const errors = [...checker.Errors(data)].map((error) => ({
      keyword: String(error.type),
      instancePath: error.path,
      schemaPath: "",
      params: {},
      message: error.message,
    }));
    validate.errors = errors;
    return errors.length === 0;
  }) as ClosedSchemaValidator;
  return validate;
}

export function setSessionCookie(reply: { header(name: string, value: string): unknown }, name: string, value: string, expiresAt: string): void {
  reply.header(
    "set-cookie",
    sessionCookie(name, value, expiresAt, isProductionEnvironment()),
  );
}

export function asPackage(value: unknown): ActivityDefinitionPackage {
  if (value === null || typeof value !== "object") {
    throw new DomainError("INVALID_INPUT", "A definition package object is required.");
  }
  const candidate = value as Partial<ActivityDefinitionPackage>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.manifest === undefined ||
    candidate.capabilities === null ||
    typeof candidate.capabilities !== "object"
  ) {
    throw new DomainError(
      "INVALID_INPUT",
      "A definition package needs schemaVersion 1, a manifest and a capabilities object.",
    );
  }
  return candidate as ActivityDefinitionPackage;
}

export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function errorDetails(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "issues" in error) {
    return (error as { issues: unknown }).issues;
  }
  return undefined;
}

export function publicErrorMessage(status: number, fallback: string): string {
  if (status === 401) return "Authentication required.";
  if (status === 403) return "Access denied.";
  if (status === 404) return "The requested resource was not found.";
  if (status === 429) return "Too many requests.";
  if (status === 413) return "Request body too large.";
  return fallback;
}
