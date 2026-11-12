// The Bazaar discovery declaration, read in the two shapes it has been published in.
//
// x402 v2 (the x402 foundation's `bazaar` extension) puts the request description under
// `extensions.bazaar.info` and a JSON schema of `{input, output}` under `extensions.bazaar.schema`,
// so the fields a client sends are at `schema.properties.input.properties.body`. Earlier
// declarations put a body schema directly at `inputSchema` (or `input.schema`, `request.schema`).
// One reader takes both, so a resource on either shape gets a form and a clean conformance report.

import { isRecord, type JsonRecord, readPath } from "./json.ts";

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  items?: JsonSchema;
}

function asSchema(value: unknown): JsonSchema | null {
  return isRecord(value) ? (value as JsonSchema) : null;
}

/** The schema of the request body a declaration describes, or null when it describes none. */
export function bazaarBodySchema(declaration: unknown): JsonSchema | null {
  if (!isRecord(declaration)) return null;
  const v2 = asSchema(readPath(declaration, "schema.properties.input.properties.body"));
  if (v2?.properties) return v2;
  return (
    asSchema(declaration.inputSchema) ??
    asSchema(readPath(declaration, "input.schema")) ??
    asSchema(readPath(declaration, "request.schema"))
  );
}

/** The example request a declaration carries: the v2 `info.input.body`, else the legacy `inputExample`. */
export function bazaarExampleBody(declaration: unknown): JsonRecord | null {
  if (!isRecord(declaration)) return null;
  const body = readPath(declaration, "info.input.body") ?? declaration.inputExample;
  return isRecord(body) ? body : null;
}
