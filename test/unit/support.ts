// Shared by the unit tests. Not a test file itself: the runner only picks up *.test.ts.

import assert from "node:assert/strict";

import { type Preset, type Target, targetFromPreset } from "../../src/lib/types.ts";

/** A target with every default filled in, from just the fields a test cares about. */
export function targetOf(preset: Partial<Preset> = {}): Target {
  return targetFromPreset({ id: "test", name: "Test source", origin: "https://api.example.test", ...preset });
}

/**
 * A value the types say cannot happen, passed on purpose: these tests feed the code what a broken
 * server sends, and the point is that it is refused rather than trusted.
 */
export function malformed<T>(value: unknown): T {
  return value as T;
}

/** Narrows a value that must be there, failing the test with `what` when it is not. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) assert.fail(`${what} is missing`);
  return value;
}

/** Narrows a `{ error }` result union to its success side. */
export function succeeded<T extends { error?: string | null | undefined }>(result: T): Exclude<T, { error: string }> {
  if (typeof result.error === "string") assert.fail(`expected success, got: ${result.error}`);
  return result as Exclude<T, { error: string }>;
}

/** Narrows a `{ error }` result union to its failure side and returns the message. */
export function failed(result: { error?: string | null | undefined }): string {
  if (typeof result.error !== "string") assert.fail("expected a failure, got a success");
  return result.error;
}
