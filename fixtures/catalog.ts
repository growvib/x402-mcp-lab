// The demo server's catalog: what it sells, and how a request body is priced.
//
// Split from mock-x402.ts so the server reads as protocol and the data reads as data.

import type { JsonRecord } from "../src/lib/json.ts";

// A catalog big enough to be a problem. Two products would let a list of two look fine forever;
// a real endpoint returns dozens, and the Choose step has to survive that, so the demo server
// generates forty across four categories, with prices that differ and variants that change the
// quote. Search and paging are served here too, because a client that filters only what it already
// downloaded is a client that lies about the total.
const CATEGORIES = [
  {
    id: "reports",
    label: "Reports",
    items: [
      "Sample report",
      "Trend report",
      "Weekly digest",
      "Audit summary",
      "Cohort breakdown",
      "Funnel report",
      "Retention report",
      "Anomaly report",
      "Coverage report",
      "Health report",
    ],
  },
  {
    id: "exports",
    label: "Exports",
    items: [
      "Bulk export",
      "Table dump",
      "Event stream slice",
      "Archive bundle",
      "Ledger extract",
      "Snapshot export",
      "Index export",
      "Backfill slice",
      "Column extract",
      "Partition dump",
    ],
  },
  {
    id: "media",
    label: "Media",
    items: [
      "Image render",
      "Thumbnail set",
      "Poster render",
      "Chart image",
      "Diagram render",
      "Sprite sheet",
      "Waveform image",
      "Preview clip",
      "Contact sheet",
      "Tile render",
    ],
  },
  {
    id: "text",
    label: "Text",
    items: [
      "Transcript",
      "Summary",
      "Translation",
      "Caption track",
      "Keyword set",
      "Outline",
      "Abstract",
      "Glossary",
      "Citation list",
      "Changelog",
    ],
  },
] as const;

export interface VariantShape {
  id: string;
  display_label: string;
  multiplier: number;
  max_quantity: number;
  quality_name?: string;
}

const VARIANT_SHAPES: readonly VariantShape[] = [
  { id: "standard", display_label: "Standard", multiplier: 1, max_quantity: 50 },
  { id: "priority", display_label: "Priority", multiplier: 5, max_quantity: 10, quality_name: "front of the queue" },
  { id: "bulk", display_label: "Bulk", multiplier: 3, max_quantity: 500, quality_name: "cheaper per unit, slower" },
];

export interface Variant {
  id: string;
  param_key: string;
  display_label: string;
  price_usd: string;
  amount: string;
  min_quantity: number;
  max_quantity: number;
  quality_name: string | undefined;
}

export interface ExpressPreset {
  key: string;
  label: string;
  param_key: string;
  subtitle: string;
}

export interface Product {
  id: string;
  title: string;
  platform: string;
  category: string;
  /** Never empty: every product is built with at least two variants. */
  variants: [Variant, ...Variant[]];
  metadata: { express_presets: ExpressPreset[] };
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function variantOf(shape: VariantShape, base: number, region = "Global"): Variant {
  const targeted = region !== "Global";
  const atomic = base * shape.multiplier * (targeted ? 2 : 1);
  return {
    id: shape.id,
    param_key: targeted ? `${slug(region)}-${shape.id}` : shape.id,
    display_label: targeted ? `${shape.display_label} · ${region}` : shape.display_label,
    price_usd: (atomic / 1e6).toFixed(2),
    amount: String(atomic),
    min_quantity: shape.id === "bulk" ? 10 : 1,
    max_quantity: shape.max_quantity,
    quality_name: shape.quality_name,
  };
}

// A real catalog does not stop at three variants. One GrowVib service carries 92 options, most of
// them a country and gender crossing of the same few qualities, and the seller publishes the two
// or three untargeted ones it actually recommends. One product here is built that way, so the
// collapsed option step is exercised against something shaped like the thing it exists for.
const REGIONS = ["Global", "USA", "Europe", "Brazil", "India", "Japan", "Turkey", "Germany", "Nigeria", "Indonesia"];

function wideVariants(base: number): [Variant, ...Variant[]] {
  const [first, ...rest] = VARIANT_SHAPES.flatMap((shape) =>
    REGIONS.map((region) => ({ ...variantOf(shape, base, region), id: `${shape.id}-${slug(region)}` })),
  );
  if (!first) throw new Error("a wide product needs at least one variant");
  return [first, ...rest];
}

function narrowVariants(base: number, count: number): [Variant, ...Variant[]] {
  const [first, ...rest] = VARIANT_SHAPES.slice(0, count).map((shape) => variantOf(shape, base));
  if (!first) throw new Error("a product needs at least one variant");
  return [first, ...rest];
}

const DEFAULT_PRESETS: ExpressPreset[] = [
  { key: "quick_cheap", label: "Cheap and standard", param_key: "standard", subtitle: "the entry price" },
  { key: "top_quality", label: "Top quality", param_key: "priority", subtitle: "front of the queue" },
];

// Deterministic, so a screenshot taken today matches one taken tomorrow.
export const PRODUCTS = new Map<string, Product>();
for (const category of CATEGORIES) {
  category.items.forEach((title, index) => {
    const base = 10000 * (1 + (index % 4)); // 0.01 to 0.04 USDC
    const id = slug(title);
    PRODUCTS.set(id, {
      id,
      title,
      platform: category.label,
      category: category.id,
      variants: narrowVariants(base, 2 + (index % 2)),
      // What this product recommends out of what it sells, named the way the catalog engine names
      // them: by the option's param_key, not by its id.
      metadata: { express_presets: DEFAULT_PRESETS.map((preset) => ({ ...preset })) },
    });
  });
}

function product(id: string): Product {
  const found = PRODUCTS.get(id);
  if (!found) throw new Error(`the fixture catalog has no ${id}`);
  return found;
}

// Bulk export is the wide one: 30 options across three qualities and ten regions, of which it
// recommends three. Every other product stays small, so both shapes are on the same server.
const BULK_EXPORT = product("bulk-export");
BULK_EXPORT.variants = wideVariants(10000);
BULK_EXPORT.metadata = {
  express_presets: [
    { key: "quick_cheap", label: "Cheap and standard", param_key: "standard", subtitle: "the entry price" },
    { key: "best_value", label: "Best value", param_key: "bulk", subtitle: "cheaper per unit, slower" },
    { key: "top_quality", label: "Top quality", param_key: "priority", subtitle: "front of the queue" },
  ],
};

const DEFAULT_PRODUCT = product("sample-report");

// The first two keep their friendly names so the guided walkthrough reads the same as before.
const FEATURED = ["sample-report", "bulk-export"];

export interface CatalogQuery {
  search: string;
  category: string;
  page: number;
  pageSize: number;
}

export function catalogPage({ search, category, page, pageSize }: CatalogQuery) {
  const query = search.trim().toLowerCase();
  const matches = (entry: Product) => !query || `${entry.title} ${entry.platform}`.toLowerCase().includes(query);
  const searched = [...PRODUCTS.values()].filter(matches);
  const all = searched
    .filter((entry) => !category || entry.category === category)
    .sort((a, b) => FEATURED.indexOf(b.id) - FEATURED.indexOf(a.id) || a.title.localeCompare(b.title));
  // Counts are computed over everything the SEARCH matched, not over the page, so a chip says how
  // many rows choosing it would give rather than how many happen to be on screen.
  const facets = new Map<string, number>();
  for (const entry of searched) facets.set(entry.category, (facets.get(entry.category) ?? 0) + 1);
  const current = Math.max(1, page || 1);
  const start = (current - 1) * pageSize;
  return {
    facets: [...facets.entries()].sort().map(([value, count]) => ({
      value,
      label: CATEGORIES.find((entry) => entry.id === value)?.label ?? value,
      count,
    })),
    data: all.slice(start, start + pageSize).map((entry) => ({
      id: entry.id,
      title: entry.title,
      platform: entry.platform,
      price_usd: entry.variants[0].price_usd,
    })),
    page: current,
    page_size: pageSize,
    total: all.length,
  };
}

export function productFor(body: JsonRecord): { product: Product; variant: Variant; units: number } {
  const chosen = PRODUCTS.get(String(body.item)) ?? DEFAULT_PRODUCT;
  const variant = chosen.variants.find((entry) => entry.id === body.variant) ?? chosen.variants[0];
  return { product: chosen, variant, units: Math.max(1, Number(body.quantity) || 1) };
}

export function amountFor(body: JsonRecord): string {
  const { variant, units } = productFor(body);
  return String(BigInt(variant.amount) * BigInt(units));
}
