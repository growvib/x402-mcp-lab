import assert from "node:assert/strict";
import test from "node:test";

import { bazaarBodySchema, bazaarExampleBody } from "../../src/lib/bazaar.ts";

const v2 = {
  info: {
    input: {
      type: "http",
      method: "POST",
      bodyType: "json",
      body: { service_id: "x", quantity: 1000, link: "https://a" },
    },
  },
  schema: {
    type: "object",
    properties: {
      input: {
        type: "object",
        properties: {
          body: {
            type: "object",
            required: ["service_id"],
            properties: { service_id: { type: "string", description: "The service." }, quantity: { type: "integer" } },
          },
        },
      },
      output: { type: "object" },
    },
  },
};
const legacy = {
  inputSchema: {
    type: "object",
    required: ["item"],
    properties: { item: { type: "string", description: "Which one." } },
  },
};

test("the body schema is read from the v2 declaration", () => {
  const schema = bazaarBodySchema(v2);
  assert.deepEqual(Object.keys(schema?.properties ?? {}), ["service_id", "quantity"]);
  assert.deepEqual(schema?.required, ["service_id"]);
  assert.deepEqual(bazaarExampleBody(v2), { service_id: "x", quantity: 1000, link: "https://a" });
});

test("the legacy inputSchema shape still reads", () => {
  assert.deepEqual(Object.keys(bazaarBodySchema(legacy)?.properties ?? {}), ["item"]);
  assert.equal(bazaarExampleBody(legacy), null);
});

test("a declaration with neither, or none at all, reads as no schema", () => {
  assert.equal(bazaarBodySchema({ info: {} }), null);
  assert.equal(bazaarBodySchema(null), null);
  assert.equal(bazaarBodySchema("x"), null);
});
