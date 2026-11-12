// What am I buying, before what am I sending.
//
// A paid resource with a catalog has two questions in front of the request: which thing, and which
// variant of it. Asking them as a form field called `service_id` is asking somebody to paste a
// uuid they do not have. So when a target publishes a catalog, the playground opens on a list and
// fills the request from the choice.
//
// The field names are configuration, not knowledge: a preset says which body field carries the
// identifier, which carries the variant and which carries the quantity. Nothing here knows what any
// particular seller's service is.
//
// Searching and filtering happen at the ENDPOINT, not in the browser. A client that filters only
// what it already downloaded shows "3 results" while meaning "3 of the 10 rows I happen to hold",
// which is a lie that gets worse the bigger the catalog is. Everything here sends the query and
// reports the total the endpoint gave back.

import { asRecord, errorMessage, isRecord, type JsonRecord, numberOf, readPath } from "./json.ts";
import type { ExpressConfig, FacetConfig, Http, Target } from "./types.ts";

export const PAGE_SIZE = 12;
/** One page can always be rendered; beyond that the list pages rather than growing without bound. */
const MAX_PAGES_HELD = 20;

export interface Facet {
  param: string;
  label: string;
  valuesPath: string;
  valueField: string;
  labelField: string;
  countField: string;
  /** A dimension the endpoint only answers for once another is chosen. */
  dependsOn: string;
}

export interface Catalog {
  list: string;
  service: string;
  idField: string;
  titleField: string;
  optionsField: string;
  searchParam: string;
  express: Required<ExpressConfig> | null;
  /** What a catalog price is a price OF ("per 1K"). Empty when a price stands alone. */
  priceUnit: string;
  pageParam: string;
  pageSizeParam: string;
  facets: Facet[];
  fields: { service: string; option: string; quantity: string; posts: string };
}

export interface Service {
  id: string;
  title: string;
  facet: string;
  metric: string;
  quality: string;
  price: string | null;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number | null;
}

export interface OptionFacts {
  /** The kind of link the order needs: post, profile, channel, story, comment. */
  linkType: string;
  startLabel: string;
  /** A per-post subscription: the order needs a post count beside the quantity. */
  requiresPosts: boolean;
}

export interface CatalogOption extends OptionFacts {
  id: string;
  /** The value an express preset names this option by. */
  match: string;
  label: string;
  slug: string | null;
  price: string | null;
  min: number;
  max: number;
  quality: string | null;
}

export interface ExpressPick {
  key: string;
  label: string;
  subtitle: string;
  option: CatalogOption;
}

export interface ServicePage {
  services: Service[];
  /** The endpoint's total, or null when it gave none (the count line then says "at least"). */
  total: number | null;
  page: number;
  pageSize: number;
  inlineFacets: FacetValue[];
  error: string | null;
}

export interface ServiceOptions {
  service: { id: string; name: string } | null;
  options: CatalogOption[];
  express: ExpressPick[];
  error: string | null;
}

export function catalogOf(target: Target | null | undefined): Catalog | null {
  const catalog = target?.catalog;
  if (!catalog?.list) return null;
  return {
    list: catalog.list,
    service: catalog.service || "",
    idField: catalog.idField || "id",
    titleField: catalog.titleField || "title",
    optionsField: catalog.optionsField || "options",
    searchParam: catalog.searchParam || "search",
    // Where the endpoint publishes the few setups it actually recommends, out of a list that can
    // run to ninety options of country and gender targeting. See readExpress for why that list is
    // not what the Choose step opens on.
    express: normaliseExpress(catalog.express),
    // A bare "$9.71" next to a service whose minimum is ten units reads as the total and is out by
    // two orders of magnitude when the seller quotes a rate per thousand.
    priceUnit: catalog.priceUnit ?? "",
    pageParam: catalog.pageParam || "page",
    pageSizeParam: catalog.pageSizeParam || "page_size",
    // Facet DIMENSIONS, each one a filter the endpoint understands by name, so the chips are the
    // endpoint's own vocabulary rather than whatever happened to be on this page.
    facets: normaliseFacets(catalog.facets),
    fields: {
      service: catalog.fields?.service || "service_id",
      option: catalog.fields?.option || "service_option_id",
      quantity: catalog.fields?.quantity || "quantity",
      posts: catalog.fields?.posts || "posts",
    },
  };
}

function normaliseExpress(express: ExpressConfig | undefined): Required<ExpressConfig> | null {
  if (!express?.path) return null;
  return {
    path: express.path,
    matchField: express.matchField || "param_key",
    keyField: express.keyField || "key",
    labelField: express.labelField || "label",
    subtitleField: express.subtitleField || "subtitle",
  };
}

function normaliseFacets(facets: ReadonlyArray<FacetConfig | string> | undefined): Facet[] {
  if (!Array.isArray(facets)) return [];
  return facets
    .map(
      (facet): Facet =>
        typeof facet === "string"
          ? {
              param: facet,
              label: facet,
              valuesPath: "",
              valueField: "value",
              labelField: "label",
              countField: "count",
              dependsOn: "",
            }
          : {
              param: facet.param || "",
              label: facet.label || facet.param || "",
              valuesPath: facet.valuesPath || "",
              valueField: facet.valueField || "value",
              labelField: facet.labelField || facet.valueField || "label",
              countField: facet.countField || "count",
              dependsOn: facet.dependsOn || "",
            },
    )
    .filter((facet) => facet.param);
}

/** The first of these fields that holds a value. */
function pick(row: unknown, ...names: string[]): unknown {
  const record = asRecord(row);
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function pickString(row: unknown, ...names: string[]): string | null {
  const value = pick(row, ...names);
  return value === null ? null : String(value);
}

/**
 * A bare number tells nobody what it is. Where the field says the unit, so does the label, and a
 * field that calls itself a STARTING price is rendered as one: the quote is the real amount.
 */
function priceLabel(row: unknown, unit = ""): string | null {
  const suffix = unit ? ` ${unit}` : "";
  const usd = pickString(row, "price_usd");
  if (usd !== null) return `$${usd}${suffix}`;
  const from = pickString(row, "starting_price_usd", "from_price_usd");
  if (from !== null) return `from $${from}${suffix}`;
  const other = pickString(row, "price", "rate");
  return other === null ? null : `${other}${suffix}`;
}

function rowsOf(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  const record = asRecord(parsed);
  for (const key of ["data", "items", "results"]) {
    const rows = record[key];
    if (Array.isArray(rows)) return rows;
  }
  // An endpoint that names its own array (`{"platforms": [...]}`) is read when there is exactly
  // one array to read. Two would be a guess, and a guess silently picks the wrong list.
  const arrays = Object.values(record).filter(Array.isArray);
  return arrays.length === 1 ? (arrays[0] as unknown[]) : [];
}

function parseBody(body: string, what: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(body) as unknown };
  } catch (error) {
    return { error: `${what} is not JSON: ${errorMessage(error)}` };
  }
}

/**
 * One page of services. A failure is returned rather than thrown: a target whose catalog is
 * unreachable should still be usable through the raw request form, which is what the Choose step
 * falls back to.
 */
export async function loadServices({
  http,
  target,
  query = "",
  filters = {},
  page = 1,
  pageSize = PAGE_SIZE,
}: {
  http: Http;
  target: Target | null;
  query?: string;
  filters?: Record<string, string>;
  page?: number;
  pageSize?: number;
}): Promise<ServicePage> {
  const empty: ServicePage = { services: [], total: null, page, pageSize, inlineFacets: [], error: null };
  const catalog = catalogOf(target);
  if (!catalog) return empty;

  const params: Record<string, string | number> = { [catalog.pageSizeParam]: pageSize, [catalog.pageParam]: page };
  if (query) params[catalog.searchParam] = query;
  for (const [param, value] of Object.entries(filters)) if (value) params[param] = value;

  const res = await http({
    method: "GET",
    path: withQuery(catalog.list, params),
    headers: { accept: "application/json" },
    note: "Catalog",
  });
  if (res.transportError) return { ...empty, error: res.transportError };
  if (res.status !== 200) return { ...empty, error: `the catalog answered ${res.status}` };

  const parsed = parseBody(res.body, "the catalog");
  if ("error" in parsed) return { ...empty, error: parsed.error };

  const services = rowsOf(parsed.value)
    .map(
      (row): Service => ({
        id: pickString(row, catalog.idField, "id", "uuid") ?? "",
        title: pickString(row, catalog.titleField, "title", "name") ?? "(unnamed)",
        // The dimensions stay separate rather than pre-joined into one string, so the view can drop
        // whichever one the person is already filtering by instead of repeating it on every row.
        facet: pickString(row, "platform", "platform_key", "category") ?? "",
        metric: pickString(row, "metric") ?? "",
        quality: pickString(row, "quality_name", "quality_tier") ?? "",
        price: priceLabel(row, catalog.priceUnit),
      }),
    )
    .filter((service) => service.id);

  return {
    services,
    // A total the endpoint did not give is not invented.
    total: numberOf(pick(parsed.value, "total", "count")) || null,
    page: numberOf(pick(parsed.value, "page")) || page,
    pageSize,
    // A single-dimension facet list carried in the response body, which is what the demo server
    // does and what a small catalog can get away with.
    inlineFacets: readInlineFacets(parsed.value),
    error: null,
  };
}

/**
 * The valid values of one dimension, from wherever the endpoint publishes them. A dimension that
 * depends on another (a metric list needs a platform) returns nothing until that one is chosen,
 * rather than asking for a list the endpoint will refuse to give.
 */
export async function loadFacetValues({
  http,
  facet,
  filters = {},
}: {
  http: Http;
  facet: Facet | null | undefined;
  filters?: Record<string, string>;
}): Promise<FacetValue[]> {
  if (!facet?.valuesPath) return [];
  if (facet.dependsOn && !filters[facet.dependsOn]) return [];

  const path = facet.valuesPath.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(filters[name] ?? ""));
  const res = await http({
    method: "GET",
    path,
    headers: { accept: "application/json" },
    note: `Catalog ${facet.label}`,
  });
  if (res.transportError || res.status !== 200) return [];
  const parsed = parseBody(res.body, "the facet list");
  if ("error" in parsed) return [];
  return rowsOf(parsed.value)
    .map(
      (row): FacetValue => ({
        value: pickString(row, facet.valueField, "key", "value") ?? "",
        label: pickString(row, facet.labelField, "name", "label") ?? "",
        count: numberOf(pick(row, facet.countField, "service_count", "count")) || null,
      }),
    )
    .filter((entry) => entry.value);
}

/** A facet list the endpoint put in the response body: one unnamed dimension. */
function readInlineFacets(parsed: unknown): FacetValue[] {
  const record = asRecord(parsed);
  const declared = record.facets ?? record.filters;
  if (!Array.isArray(declared)) return [];
  return declared
    .map((entry: unknown): FacetValue => {
      if (typeof entry === "string") return { value: entry, label: entry, count: null };
      const value = pickString(entry, "value", "id") ?? "";
      return { value, label: pickString(entry, "label") ?? value, count: numberOf(asRecord(entry).count) ?? null };
    })
    .filter((entry) => entry.value);
}

/**
 * The variants of one service. They matter more than they look: each carries its own price and its
 * own minimum, and a quantity valid for one is refused for another with a message about the option
 * rather than about what was typed.
 */
export async function loadOptions({
  http,
  target,
  serviceId,
}: {
  http: Http;
  target: Target | null;
  serviceId: string | null | undefined;
}): Promise<ServiceOptions> {
  const none: ServiceOptions = { service: null, options: [], express: [], error: null };
  const catalog = catalogOf(target);
  if (!catalog?.service || !serviceId) return none;

  const path = catalog.service.replace("{id}", encodeURIComponent(serviceId));
  const res = await http({ method: "GET", path, headers: { accept: "application/json" }, note: "Catalog options" });
  if (res.transportError) return { ...none, error: res.transportError };
  if (res.status !== 200) return { ...none, error: `the service read answered ${res.status}` };

  const parsed = parseBody(res.body, "the service read");
  if ("error" in parsed) return { ...none, error: parsed.error };

  const root = asRecord(parsed.value);
  const body = isRecord(root.data) ? root.data : root;
  const rows = body[catalog.optionsField];
  const options = (Array.isArray(rows) ? rows : [])
    .map(
      (option): CatalogOption => ({
        id: pickString(option, "id") ?? "",
        match: pickString(option, catalog.express?.matchField || "param_key") ?? "",
        label: pickString(option, "display_label", "label", "name", "param_key") ?? "Option",
        slug: pickString(option, "slug"),
        price: priceLabel(option, catalog.priceUnit),
        min: numberOf(pick(option, "min_quantity", "min")) ?? 1,
        max: numberOf(pick(option, "max_quantity", "max")) ?? 0,
        quality: pickString(option, "quality_name", "quality"),
        ...optionFacts(option),
      }),
    )
    .filter((option) => option.id);

  return {
    service: { id: serviceId, name: pickString(body, "name", "title") ?? "Service" },
    options,
    express: readExpress(body, catalog, options),
    error: null,
  };
}

/**
 * The endpoint's own recommended setups, resolved to the options they name.
 *
 * One real service carries 92 options, most of them a country and gender crossing (Standard,
 * Brazil, Female), and the catalog engine already picks the two or three untargeted ones worth
 * selling. Rendering all 92 is noise the person has to read past to find the row the seller would
 * have recommended anyway. A preset naming an option the endpoint did not return is dropped.
 */
function readExpress(body: JsonRecord, catalog: Catalog, options: CatalogOption[]): ExpressPick[] {
  const express = catalog.express;
  if (!express) return [];
  const declared = readPath(body, express.path);
  if (!Array.isArray(declared)) return [];

  const byMatch = new Map(options.filter((option) => option.match).map((option) => [option.match, option]));
  return declared.flatMap((entry: unknown): ExpressPick[] => {
    const option = byMatch.get(pickString(entry, express.matchField) ?? "");
    if (!option) return [];
    return [
      {
        key: pickString(entry, express.keyField) ?? "",
        label: pickString(entry, express.labelField) ?? option.label,
        subtitle: pickString(entry, express.subtitleField) ?? "",
        option,
      },
    ];
  });
}

/**
 * Writes the choice into the request body under the field names the preset gave. The quantity is
 * raised to the option's minimum rather than left to be refused later.
 */
export function applySelection(
  body: JsonRecord,
  {
    catalog,
    serviceId,
    option,
  }: { catalog: Catalog; serviceId: string | null | undefined; option: CatalogOption | null | undefined },
): JsonRecord {
  const next: JsonRecord = { ...body };
  if (serviceId) next[catalog.fields.service] = serviceId;
  if (option?.id) next[catalog.fields.option] = option.id;
  const quantityField = catalog.fields.quantity;
  if (option && Number.isFinite(option.min) && option.min > 0) {
    const current = Number(next[quantityField]);
    if (!Number.isFinite(current) || current < option.min) next[quantityField] = option.min;
  }
  // A per-post subscription needs a post count beside the quantity (which is then the amount per
  // post); the endpoint refuses the order without one. Start it at one post, visibly, rather than
  // letting the first quote fail on a field the person never saw.
  const postsField = catalog.fields.posts;
  if (option?.requiresPosts) {
    if (!(Number(next[postsField]) > 0)) next[postsField] = 1;
  } else if (option) {
    delete next[postsField];
  }
  return next;
}

/**
 * What an option says about how it is ordered, off the metadata the seller's catalog wrote: the
 * kind of link it takes, the start window it lists, and whether it is a per-post subscription.
 * Public catalog rows carry these under `metadata`; an MCP catalog flattens them to `link_type`,
 * `start_within` and `requires_posts`, so both spellings are read.
 */
export function optionFacts(option: unknown): OptionFacts {
  const meta = asRecord(asRecord(option).metadata);
  const params = Array.isArray(meta.order_params) ? meta.order_params : [];
  const asksForPosts = params.some((param) => asRecord(param).key === "posts");
  return {
    linkType: (pickString(option, "link_type") ?? pickString(meta, "link_type") ?? "").toLowerCase(),
    startLabel: pickString(option, "start_within") ?? pickString(meta, "start_label") ?? "",
    requiresPosts: Boolean(pick(option, "requires_posts")) || asksForPosts,
  };
}

export function pageCount(total: number | null, pageSize = PAGE_SIZE): number | null {
  if (!total) return null;
  return Math.min(MAX_PAGES_HELD, Math.ceil(total / pageSize));
}

function withQuery(path: string, params: Record<string, string | number>): string {
  const [base = "", existing = ""] = path.split("?");
  const search = new URLSearchParams(existing);
  for (const [key, value] of Object.entries(params)) search.set(key, String(value));
  return `${base}?${search.toString()}`;
}
