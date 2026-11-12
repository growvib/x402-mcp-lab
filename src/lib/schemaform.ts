// A form built from a JSON Schema, which is what makes this tool work against a resource it has
// never seen.
//
// x402's Bazaar declaration carries the schema of the request body, and MCP carries one per tool.
// Both are the same shape of document, so both build the same form: type, description, required,
// enum, default. Anything the subset below cannot render falls back to a JSON box rather than
// silently dropping a field, because a request missing a field it did not know about fails in a
// way that looks like the server's fault.

import type { JsonSchema } from "./bazaar.ts";
import { errorMessage, type JsonRecord } from "./json.ts";
import { el } from "./ui.ts";

type FieldInput = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const SIMPLE = new Set(["string", "number", "integer", "boolean"]);

export interface Form {
  fields: HTMLElement[];
  /** The values, typed as the schema says. Throws when the raw form holds something that is not JSON. */
  read(): JsonRecord;
  /** Required fields with no value. */
  missing(): string[];
}

export function isRenderable(schema: JsonSchema | null | undefined): schema is JsonSchema {
  if (schema?.type !== "object" || !schema.properties) return false;
  return Object.values(schema.properties).every(
    (prop) =>
      SIMPLE.has(prop.type ?? "") || Array.isArray(prop.enum) || prop.type === "object" || prop.type === "array",
  );
}

function inputFor(name: string, prop: JsonSchema, value: unknown): FieldInput {
  if (Array.isArray(prop.enum)) {
    return el(
      "select",
      { name },
      ...prop.enum.map((option) => el("option", { selected: String(option) === String(value) }, String(option))),
    );
  }
  if (prop.type === "boolean") {
    return el(
      "select",
      { name },
      el("option", { selected: value === false }, "false"),
      el("option", { selected: value === true }, "true"),
    );
  }
  if (prop.type === "object" || prop.type === "array") {
    return el(
      "textarea",
      { name, spellcheck: "false", class: "json-field" },
      value === "" ? "" : JSON.stringify(value, null, 2),
    );
  }
  const example = (prop as { examples?: unknown[] }).examples?.[0];
  return el("input", {
    name,
    spellcheck: "false",
    value: value === null || value === undefined ? "" : String(value),
    placeholder: example !== undefined ? String(example) : (prop.type ?? ""),
  });
}

/**
 * The fields and a read() that collects them, typed as the schema says. A quantity sent as the
 * string "100" against a schema that says integer is refused by a strict server, and the refusal
 * talks about the field rather than about the type.
 */
export function buildForm(
  schema: JsonSchema,
  { values = {}, hidden = [], onChange }: { values?: JsonRecord; hidden?: string[]; onChange?: () => void } = {},
): Form {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const inputs = new Map<string, { input: FieldInput; prop: JsonSchema }>();

  const fields = Object.entries(properties)
    .filter(([name]) => !hidden.includes(name))
    .map(([name, prop]) => {
      const input = inputFor(name, prop, values[name] ?? prop.default ?? "");
      if (onChange) input.addEventListener("input", onChange);
      inputs.set(name, { input, prop });

      return el(
        "div",
        {},
        el(
          "label",
          {},
          name,
          required.has(name)
            ? el("span", { class: "required" }, " required")
            : el("span", { class: "dim" }, ` ${prop.type ?? ""}`),
        ),
        input,
        prop.description
          ? el("p", { class: "dim field-hint" }, prop.description)
          : el("p", { class: "field-hint warn-text" }, "no description in the schema"),
      );
    });

  function read(): JsonRecord {
    const out: JsonRecord = {};
    for (const [name, { input, prop }] of inputs) {
      const raw = input.value;
      if (raw === "") {
        // An absent optional field is OMITTED, never sent as an empty string. A server that reads
        // "" as "not a uuid" refuses, where an absent field means "use the default".
        if (required.has(name)) out[name] = raw;
        continue;
      }
      if (prop.type === "integer" || prop.type === "number") {
        const parsed = Number(raw);
        out[name] = Number.isFinite(parsed) ? parsed : raw;
      } else if (prop.type === "boolean") {
        out[name] = raw === "true";
      } else if (prop.type === "object" || prop.type === "array") {
        try {
          out[name] = JSON.parse(raw) as unknown;
        } catch {
          out[name] = raw;
        }
      } else {
        out[name] = raw;
      }
    }
    return out;
  }

  return {
    fields,
    read,
    missing() {
      const current = read();
      return [...required].filter((name) => current[name] === undefined || current[name] === "");
    },
  };
}

/**
 * The fallback: one JSON box. It is also always available behind a toggle, because a tester whose
 * form cannot express what you want to send is a tester you have to stop using at exactly the
 * moment it got interesting.
 */
export function rawForm(value: unknown): Form {
  const input = el("textarea", { name: "__raw", spellcheck: "false" }, JSON.stringify(value ?? {}, null, 2));
  return {
    fields: [el("div", {}, el("label", {}, "request body"), input)],
    read() {
      try {
        const parsed: unknown = JSON.parse(input.value || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("the request body must be a JSON object");
        }
        return parsed as JsonRecord;
      } catch (error) {
        throw new Error(`the request body is not JSON: ${errorMessage(error)}`);
      }
    },
    missing: () => [],
  };
}
