// The catalog module, with the transport injected.
//
// The thing worth pinning here is not the parsing, it is WHERE the filtering happens. Every
// assertion below is about a request that went out: the search, the facet and the page have to
// reach the endpoint, because a client that filters the page it already holds reports a count that
// is true of its own memory and false about the catalog.

import assert from "node:assert/strict";
import test from "node:test";

import {
  applySelection,
  type Catalog,
  type CatalogOption,
  catalogOf,
  type Facet,
  loadFacetValues,
  loadOptions,
  loadServices,
  optionFacts,
  pageCount,
} from "../../src/lib/catalog.ts";
import type { CatalogConfig, Http, HttpRequest } from "../../src/lib/types.ts";
import { present, targetOf } from "./support.ts";

const CATALOG: CatalogConfig = {
  list: "/v1/services",
  service: "/v1/services/{id}",
  searchParam: "search",
  facets: [
    {
      param: "platform_key",
      label: "Platform",
      valuesPath: "/v1/services/platforms",
      valueField: "key",
      labelField: "name",
      countField: "service_count",
    },
    {
      param: "metric",
      label: "Metric",
      valuesPath: "/v1/services/metrics?platform_key={platform_key}",
      valueField: "key",
      labelField: "label",
      dependsOn: "platform_key",
    },
  ],
  fields: { service: "service_id", option: "service_option_id", quantity: "quantity" },
};
const TARGET = targetOf({ catalog: CATALOG });

function transport(body: unknown, { status = 200 } = {}): { http: Http; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const http: Http = async (request) => {
    calls.push(request);
    return { status, body: JSON.stringify(body), headers: {} };
  };
  return { http, calls };
}

/** The path of the nth request, failing the test when there were fewer. */
function pathOf(calls: HttpRequest[], index: number): string {
  return present(present(calls[index], `request ${index}`).path, `the path of request ${index}`);
}

/** The catalog a target declares, failing the test when it declares none. */
function catalog(target = TARGET): Catalog {
  return present(catalogOf(target), "the catalog");
}

function facet(index: number): Facet {
  return present(catalog().facets[index], `facet ${index}`);
}

/** An option with every field filled in, from the ones a test cares about. */
function option(fields: Partial<CatalogOption> & { id: string }): CatalogOption {
  return {
    match: "",
    label: fields.id,
    slug: null,
    price: null,
    min: 0,
    max: 0,
    quality: null,
    linkType: "",
    startLabel: "",
    requiresPosts: false,
    ...fields,
  };
}

test("the search, the filters and the page are sent to the endpoint", async () => {
  const { http, calls } = transport({ data: [{ id: "a", title: "A" }], total: 412, page: 3 });
  const result = await loadServices({
    http,
    target: TARGET,
    query: "growth",
    filters: { platform_key: "instagram", metric: "followers" },
    page: 3,
  });

  const url = new URL(pathOf(calls, 0), "http://x");
  assert.equal(url.pathname, "/v1/services");
  assert.equal(url.searchParams.get("search"), "growth");
  assert.equal(url.searchParams.get("platform_key"), "instagram");
  assert.equal(url.searchParams.get("metric"), "followers");
  assert.equal(url.searchParams.get("page"), "3");
  assert.equal(url.searchParams.get("page_size"), "12");
  // The total is the endpoint's, not the length of what came back.
  assert.equal(result.total, 412);
  assert.equal(result.services.length, 1);
});

test("a total the endpoint did not give is null, never the row count", async () => {
  const { http } = transport([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
  const result = await loadServices({ http, target: TARGET });
  assert.equal(result.total, null);
  assert.equal(result.services.length, 2);
});

test("a catalog that fails comes back as an error, with the same shape", async () => {
  const { http } = transport({}, { status: 503 });
  const result = await loadServices({ http, target: TARGET });
  assert.match(result.error ?? "", /503/);
  assert.deepEqual(result.services, []);
  assert.deepEqual(result.inlineFacets, []);
  assert.equal(result.total, null);
});

test("facets carried in the response body are read as one dimension", async () => {
  const { http } = transport({ data: [], facets: [{ value: "media", label: "Media", count: 10 }, "text"] });
  const result = await loadServices({ http, target: TARGET });
  assert.deepEqual(result.inlineFacets, [
    { value: "media", label: "Media", count: 10 },
    { value: "text", label: "text", count: null },
  ]);
});

test("a dimension that depends on another asks for nothing until that one is chosen", async () => {
  const metric = facet(1);
  const { http, calls } = transport([{ key: "followers", label: "Followers" }]);

  assert.deepEqual(await loadFacetValues({ http, facet: metric, filters: {} }), []);
  assert.equal(calls.length, 0, "it asked for the dependent list anyway");

  const values = await loadFacetValues({ http, facet: metric, filters: { platform_key: "instagram" } });
  assert.equal(pathOf(calls, 0), "/v1/services/metrics?platform_key=instagram");
  assert.deepEqual(values, [{ value: "followers", label: "Followers", count: null }]);
});

test("a facet list that fails leaves the row empty rather than throwing", async () => {
  const platform = facet(0);
  const { http } = transport({}, { status: 500 });
  assert.deepEqual(await loadFacetValues({ http, facet: platform, filters: {} }), []);
});

test("an endpoint that names its own array is read, and an ambiguous body is not guessed", async () => {
  const platform = facet(0);
  const named = transport({ platforms: [{ key: "instagram", name: "Instagram", service_count: 50 }] });
  assert.deepEqual(await loadFacetValues({ http: named.http, facet: platform, filters: {} }), [
    { value: "instagram", label: "Instagram", count: 50 },
  ]);

  const ambiguous = transport({ platforms: [{ key: "a" }], deprecated: [{ key: "b" }] });
  assert.deepEqual(await loadFacetValues({ http: ambiguous.http, facet: platform, filters: {} }), []);
});

test("a starting price is labelled as one, with the unit the preset declares", async () => {
  const target = targetOf({ catalog: { ...CATALOG, priceUnit: "per 1K" } });
  const { http } = transport({
    data: [
      { id: "a", name: "A", starting_price_usd: 9.714 },
      { id: "b", name: "B", price_usd: "0.05" },
    ],
  });
  const result = await loadServices({ http, target });
  // A rate rendered as a total is out by three orders of magnitude on a service whose minimum is ten.
  assert.equal(result.services[0]?.price, "from $9.714 per 1K");
  assert.equal(result.services[1]?.price, "$0.05 per 1K");
});

const EXPRESS_TARGET = targetOf({
  catalog: {
    ...CATALOG,
    express: { path: "metadata.express_presets", matchField: "param_key" },
  },
});

const SERVICE_DETAIL = {
  name: "Instagram Followers",
  metadata: {
    express_presets: [
      { key: "quick_cheap", label: "Cheap and standard", param_key: "standard", subtitle: "" },
      { key: "best_value", label: "Best value", param_key: "real", subtitle: "High Quality" },
      { key: "gone", label: "Names an option that is not here", param_key: "withdrawn" },
    ],
  },
  options: [
    { id: "opt-std", param_key: "standard", display_label: "Standard", price_usd: "5.39", min_quantity: 10 },
    { id: "opt-real", param_key: "real", display_label: "Real", price_usd: "9.10", min_quantity: 10 },
    { id: "opt-usa", param_key: "usa-standard", display_label: "Standard - USA", price_usd: "12.00", min_quantity: 10 },
  ],
};

test("the setups an endpoint recommends are resolved to the options they name", async () => {
  const { http } = transport(SERVICE_DETAIL);
  const { options, express } = await loadOptions({ http, target: EXPRESS_TARGET, serviceId: "svc" });

  assert.equal(
    options.length,
    3,
    "the full list is still returned: the recommendation is a view of it, not a filter on it",
  );
  assert.deepEqual(
    express.map((entry) => [entry.key, entry.label, entry.option.id]),
    [
      ["quick_cheap", "Cheap and standard", "opt-std"],
      ["best_value", "Best value", "opt-real"],
    ],
  );
  // A preset naming an option the endpoint did not return would render as a row that cannot be
  // chosen, so it is dropped.
  assert.ok(!express.some((entry) => entry.key === "gone"), "a preset with no matching option was rendered anyway");
});

test("a source that declares no express block gets none, and the full list is untouched", async () => {
  const { http } = transport(SERVICE_DETAIL);
  const { options, express } = await loadOptions({ http, target: TARGET, serviceId: "svc" });
  assert.deepEqual(express, []);
  assert.equal(options.length, 3);
});

test("the choice is written under the field names the preset declares", () => {
  const body = applySelection(
    { quantity: 1 },
    { catalog: catalog(), serviceId: "svc", option: option({ id: "opt", min: 100 }) },
  );
  assert.deepEqual(body, { service_id: "svc", service_option_id: "opt", quantity: 100 });
});

test("the page count is bounded, so a huge catalog is searched and not paged through", () => {
  assert.equal(pageCount(0), null);
  assert.equal(pageCount(40), 4);
  assert.equal(pageCount(40000), 20);
});

test("an option states the link it takes, its start window and whether it is a per-post subscription", () => {
  const facts = optionFacts({
    id: "o",
    metadata: { link_type: "channel", start_label: "0-6 Hours", order_params: [{ key: "username" }, { key: "posts" }] },
  });
  assert.deepEqual(facts, { linkType: "channel", startLabel: "0-6 Hours", requiresPosts: true });
  // The MCP catalog's flattened spelling reads the same.
  assert.deepEqual(optionFacts({ id: "o", link_type: "post", start_within: "0-15 Minutes", requires_posts: false }), {
    linkType: "post",
    startLabel: "0-15 Minutes",
    requiresPosts: false,
  });
  assert.deepEqual(optionFacts({ id: "o" }), { linkType: "", startLabel: "", requiresPosts: false });
});

test("choosing a per-post subscription puts a post count in the body, and choosing a plain option takes it out", () => {
  const fields = catalog(
    targetOf({
      catalog: {
        list: "/v1/services",
        fields: { service: "service_id", option: "service_option_id", quantity: "quantity" },
      },
    }),
  );
  const subscription = option({ id: "o-sub", min: 10, requiresPosts: true });
  const sub = applySelection({ quantity: 100 }, { catalog: fields, serviceId: "svc", option: subscription });
  assert.equal(sub.posts, 1);
  const kept = applySelection(sub, { catalog: fields, serviceId: "svc", option: subscription });
  assert.equal(kept.posts, 1);
  const plain = applySelection(
    { ...sub, posts: 3 },
    { catalog: fields, serviceId: "svc", option: option({ id: "o-plain", min: 10, requiresPosts: false }) },
  );
  assert.equal(plain.posts, undefined);
});
