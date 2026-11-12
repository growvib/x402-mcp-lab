// Reading JSON that came from somebody else.
//
// Everything this tool parses was written by a server under test, so nothing is trusted to have the
// shape a spec says it should. These helpers are how a value typed `unknown` becomes something the
// code can read without a cast that would turn a malformed answer into a crash.

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as a record, or an empty one, so optional fields read as absent rather than throwing. */
export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

/** Parses text, returning `undefined` for anything that is not JSON. */
export function tryParseJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A non-empty string, or `undefined`. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A finite number from a number or a numeric string, or `undefined`. */
export function numberOf(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Walks a dotted path ("metadata.express_presets") through nested records. */
export function readPath(value: unknown, path: string): unknown {
  let node: unknown = value;
  for (const key of path.split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** The message of anything thrown, for the places that report a failure as text. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}
