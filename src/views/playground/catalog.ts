// Choosing what to buy, before choosing what to send.
//
// Two questions: which thing, and which setup of it. Both are answered from what the endpoint
// publishes, and the answer fills the request under the field names the preset declares, so
// nothing here knows what a GrowVib service is.
//
// The searching, the filtering and the paging happen at the ENDPOINT. A client that filters the
// rows it already holds reports "12 results" while meaning "12 of the 12 rows in my memory", which
// is how somebody concludes a catalog of four hundred has nothing in it. The one place this page
// filters locally is the option list, where a single request really does return every option, and
// the count line says as much.

import { app, currentTarget, http, render, targetKey } from "../../app.ts";
import {
  applySelection,
  type CatalogOption,
  catalogOf,
  type ExpressPick,
  type Facet,
  type FacetValue,
  loadFacetValues,
  loadOptions,
  loadServices,
  PAGE_SIZE,
  pageCount,
  type Service,
} from "../../lib/catalog.ts";
import { isRecord } from "../../lib/json.ts";
import { debounce, el } from "../../lib/ui.ts";
import { type CatalogState, type ChosenService, currentBody, emptyChoice, goTo, state } from "./state.ts";

// Chips past this are folded behind "N more". A dozen platforms is a row you read; forty is a wall.
const CHIP_CAP = 8;

const RECENT_CAP = 5;

// A long option list is collapsed to what the endpoint recommends. Past this many, the full list
// is something you ask for rather than something you scroll past: one real service carries 92
// options, most of them a country and gender crossing of the same three qualities.
const FULL_LIST_THRESHOLD = 6;

const COLUMN = { style: { display: "flex", flexDirection: "column", gap: "12px" } };

export function catalogState(): CatalogState {
  return state().cat;
}

function facets(): Facet[] {
  return catalogOf(app.target)?.facets ?? [];
}

// A dimension whose values depend on another is cached per value of that other one: the metrics of
// Instagram are not the metrics of TikTok.
function facetKey(facet: Facet, filters: Record<string, string>): string {
  return `${facet.param}|${facet.dependsOn ? (filters[facet.dependsOn] ?? "") : ""}`;
}

async function refreshCatalog({ page = 1 }: { page?: number } = {}): Promise<void> {
  const cat = catalogState();
  cat.page = page;
  cat.loading = true;
  // Typing produces overlapping reads and they do not come back in order. Only the newest one is
  // allowed to write: a slower earlier query landing last would show results for a query nobody is
  // looking at any more, with a count line to match.
  cat.seq += 1;
  const seq = cat.seq;
  // Re-rendering to show "reading..." would replace the search box under the person typing into it,
  // and a keystroke landing in the gap is a keystroke lost. While they are in the box, the screen
  // waits and repaints once, when there is something to say.
  if (!cat.searchFocused) render();

  const res = await loadServices({ http, target: app.target, query: cat.query, filters: cat.filters, page });
  if (seq !== cat.seq) return;

  cat.services = res.services;
  cat.total = res.total;
  cat.pageSize = res.pageSize || PAGE_SIZE;
  cat.inline = res.inlineFacets;
  cat.error = res.error;
  cat.loading = false;
  render();
  restoreSearchFocus();
  await loadFacets();
}

/** Starts a catalog read. Its failures land on the page through the state, so nothing is left to catch. */
function refreshSoon(page = 1): void {
  void refreshCatalog({ page });
}

// The declared dimensions are read once each, after the list, so a slow facet endpoint never delays
// the thing somebody is waiting for.
async function loadFacets(): Promise<void> {
  const cat = catalogState();
  for (const facet of facets()) {
    if (!facet.valuesPath) continue;
    if (facet.dependsOn && !cat.filters[facet.dependsOn]) continue;
    const key = facetKey(facet, cat.filters);
    if (cat.values[key] || cat.pending.has(key)) continue;
    cat.pending.add(key);
    const values = await loadFacetValues({ http, facet, filters: cat.filters });
    cat.pending.delete(key);
    cat.values[key] = values;
    render();
    restoreSearchFocus();
  }
}

function setFilter(param: string, value: string): void {
  const cat = catalogState();
  if (value) cat.filters[param] = value;
  else delete cat.filters[param];
  // Choosing a platform invalidates the metric under the old one, so it is dropped rather than sent
  // as a filter the endpoint will answer with nothing.
  for (const facet of facets()) {
    if (facet.dependsOn === param) delete cat.filters[facet.param];
  }
  refreshSoon();
}

function clearCatalogFilters(): void {
  const cat = catalogState();
  cat.query = "";
  cat.filters = {};
  refreshSoon();
}

/**
 * Puts focus and the caret back in a search box a re-render replaced. The caret goes back exactly
 * where it was rather than at the end: somebody fixing a typo in the middle of a word should not
 * have the rest of the word land behind their cursor.
 */
function restoreFocus(id: string, focused: boolean, caret: number | null): void {
  if (!focused) return;
  const node = document.getElementById(id);
  if (!(node instanceof HTMLInputElement) || document.activeElement === node) return;
  node.focus();
  const at = Math.min(caret ?? node.value.length, node.value.length);
  try {
    node.setSelectionRange(at, at);
  } catch {
    // Some browsers refuse a selection range on a search input; focus alone is still right.
  }
}

function restoreSearchFocus(): void {
  const cat = catalogState();
  restoreFocus("catalogSearch", cat.searchFocused, cat.caret);
}

const searchSoon = debounce(() => refreshSoon(), 250);

// Recent choices are per source and live in this browser only. On a catalog this size, the thing
// somebody wants next is usually the thing they bought last.
function recentKey(): string {
  return `x402-lab:recent:${targetKey()}`;
}

function recentChoices(): ChosenService[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey()) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecord)
      .filter((entry) => typeof entry.id === "string" && entry.id !== "")
      .map((entry) => ({ id: String(entry.id), title: typeof entry.title === "string" ? entry.title : "" }))
      .slice(0, RECENT_CAP);
  } catch {
    return [];
  }
}

function rememberChoice(service: ChosenService): void {
  try {
    const next = [
      { id: service.id, title: service.title },
      ...recentChoices().filter((entry) => entry.id !== service.id),
    ];
    localStorage.setItem(recentKey(), JSON.stringify(next.slice(0, RECENT_CAP)));
  } catch {
    // A private window: recent choices are a convenience, never a requirement.
  }
}

async function chooseService(service: ChosenService): Promise<void> {
  const s = state();
  s.choice = { ...emptyChoice(), service };
  s.optionsError = null;
  rememberChoice(service);
  render();
  const { options, express, error } = await loadOptions({ http, target: app.target, serviceId: service.id });
  s.choice.options = options;
  s.choice.express = express;
  s.optionsError = error;
  const [only] = options;
  if (only && options.length === 1) chooseOption(only, { advance: false });
  render();
}

export function chooseOption(option: CatalogOption, { advance = true }: { advance?: boolean } = {}): void {
  const s = state();
  const catalog = catalogOf(app.target);
  s.choice.option = option;
  if (catalog) s.body = applySelection(currentBody(), { catalog, serviceId: s.choice.service?.id, option });
  s.form = null;
  if (advance) goTo("request");
  else render();
}

export function stepChoose(): HTMLElement {
  const s = state();
  const cat = catalogState();
  if (cat.services === null && !cat.loading) refreshSoon();
  return s.choice.service ? variantCard(s.choice.service) : catalogCard();
}

function catalogCard(): HTMLElement {
  const cat = catalogState();
  const rows = cat.services ?? [];
  const filtered = Boolean(cat.query) || Object.keys(cat.filters).length > 0;
  const byHand = () => goTo("request");

  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el("h3", {}, "What to buy"),
      el("div", { class: "grow" }),
      el(
        "button",
        {
          class: "sm quiet",
          onClick: () => {
            cat.values = {};
            refreshSoon(cat.page);
          },
        },
        "Reload",
      ),
    ),
    el(
      "div",
      { class: "card-body" },
      el("input", {
        id: "catalogSearch",
        type: "search",
        autocomplete: "off",
        placeholder: `Search the catalog on ${currentTarget().name}`,
        value: cat.query,
        // Bound to input, never to change: a change fires on blur, which is exactly when somebody is
        // moving the pointer onto a row, and the row would be replaced under their click.
        onInput: (event: Event) => {
          if (!(event.target instanceof HTMLInputElement)) return;
          cat.query = event.target.value;
          cat.caret = event.target.selectionStart;
          cat.searchFocused = true;
          searchSoon();
        },
        onFocus: () => {
          cat.searchFocused = true;
        },
        onBlur: () => {
          cat.searchFocused = false;
        },
      }),

      ...facetRows(),
      recentRow(),

      cat.error
        ? el(
            "div",
            { class: "callout warn" },
            el(
              "div",
              { class: "callout-body" },
              el("b", {}, "The catalog could not be read. "),
              cat.error,
              el(
                "div",
                { style: { marginTop: "10px" } },
                el("button", { class: "sm", onClick: byHand }, "Build the request by hand"),
              ),
            ),
          )
        : null,

      countLine(),

      rows.length ? el("div", { class: "pick-list" }, ...rows.map(serviceRow)) : null,

      !rows.length && !cat.loading && !cat.error
        ? el(
            "div",
            { class: "empty" },
            el(
              "p",
              {},
              filtered
                ? "Nothing in this catalog matches what you asked for."
                : "This endpoint published a catalog and it came back empty.",
            ),
            el(
              "div",
              { class: "row" },
              filtered ? el("button", { class: "sm", onClick: clearCatalogFilters }, "Clear the search") : null,
              el("button", { class: "sm quiet", onClick: byHand }, "Build the request by hand"),
            ),
          )
        : null,

      pager(),
    ),
    el(
      "div",
      { class: "card-foot" },
      el("button", { class: "quiet", onClick: byHand }, "Skip and write the request"),
      el(
        "span",
        { class: "help" },
        rows.length
          ? "Pick one. Your choice fills the request fields, and you can still edit them."
          : "Nothing here is needed to send a request: the fields can be written by hand.",
      ),
    ),
  );
}

// One row per dimension the source declares. A dimension the endpoint only answers for once another
// is chosen is not shown empty and not shown disabled: it appears when it has something to say.
function facetRows(): HTMLElement[] {
  return facets().flatMap((facet) => {
    const values = facetValues(facet);
    return values.length ? [chipRow(facet, values)] : [];
  });
}

function facetValues(facet: Facet): FacetValue[] {
  const cat = catalogState();
  if (!facet.valuesPath) return cat.inline;
  if (facet.dependsOn && !cat.filters[facet.dependsOn]) return [];
  return cat.values[facetKey(facet, cat.filters)] ?? [];
}

function chipRow(facet: Facet, values: FacetValue[]): HTMLElement {
  const cat = catalogState();
  const chosen = cat.filters[facet.param] ?? "";
  const expanded = cat.expanded[facet.param] === true;
  const shown = expanded ? values.slice() : values.slice(0, CHIP_CAP);
  // A chosen value that sits below the fold still shows, or the row would claim "All" while a
  // filter is on.
  if (!expanded && chosen && !shown.some((value) => value.value === chosen)) {
    const hit = values.find((value) => value.value === chosen);
    if (hit) shown.unshift(hit);
  }

  return el(
    "div",
    { class: "chip-row" },
    el("span", { class: "chip-label" }, facet.label),
    el("button", { class: `chip ${chosen ? "" : "on"}`, onClick: () => setFilter(facet.param, "") }, "All"),
    ...shown.map((value) =>
      el(
        "button",
        {
          class: `chip ${chosen === value.value ? "on" : ""}`,
          onClick: () => setFilter(facet.param, chosen === value.value ? "" : value.value),
        },
        value.label,
        value.count ? el("span", { class: "chip-count" }, String(value.count)) : null,
      ),
    ),
    values.length > shown.length
      ? el(
          "button",
          {
            class: "chip more",
            onClick: () => {
              cat.expanded[facet.param] = true;
              render();
            },
          },
          `${values.length - shown.length} more`,
        )
      : null,
  );
}

function recentRow(): HTMLElement | null {
  const recent = recentChoices();
  if (!recent.length || state().choice.service) return null;
  return el(
    "div",
    { class: "chip-row" },
    el("span", { class: "chip-label" }, "Recent"),
    ...recent.map((entry) =>
      el("button", { class: "chip", onClick: () => void chooseService(entry) }, entry.title || entry.id),
    ),
  );
}

// What is on the screen, out of what exists. A client that filters its own downloaded page says
// "12 results" and means "12 of the 12 rows I happen to hold", which is how somebody concludes a
// catalog of four hundred has nothing in it.
function countLine(): HTMLElement | null {
  const cat = catalogState();
  if (cat.loading) return el("div", { class: "count-line" }, "Reading the catalog...");
  const rows = cat.services ?? [];
  if (!rows.length) return null;

  const from = (cat.page - 1) * cat.pageSize + 1;
  const to = from + rows.length - 1;
  const span =
    cat.total === null
      ? `Showing ${from}-${to}. This catalog does not report a total.`
      : `Showing ${from}-${to} of ${cat.total}`;

  const description = describeFilters();
  return el(
    "div",
    { class: "count-line" },
    el("span", {}, span),
    description ? el("span", { class: "muted" }, description) : null,
    el("div", { class: "grow" }),
    description ? el("button", { class: "sm quiet", onClick: clearCatalogFilters }, "Clear") : null,
  );
}

function describeFilters(): string {
  const cat = catalogState();
  const parts: string[] = [];
  for (const facet of facets()) {
    const chosen = cat.filters[facet.param];
    if (!chosen) continue;
    const hit = facetValues(facet).find((value) => value.value === chosen);
    parts.push(hit?.label || chosen);
  }
  if (cat.query) parts.push(`"${cat.query}"`);
  return parts.join(" · ");
}

// A row carries the endpoint's keys ("discord", "live-viewers"); the facet lists carry that same
// endpoint's display names for them. Using one to read the other beats title-casing a slug and
// inventing "Tiktok".
function facetLabelFor(value: string): string {
  if (!value) return "";
  for (const facet of facets()) {
    const hit = facetValues(facet).find((entry) => entry.value === value);
    if (hit?.label) return hit.label;
  }
  return value;
}

function serviceRow(service: Service): HTMLElement {
  // "Instagram" on every row of a list already filtered to Instagram is noise in the one place
  // that has to stay scannable, so an active filter is not repeated per row.
  const active = new Set(Object.values(catalogState().filters));
  const meta = [
    service.facet && !active.has(service.facet) ? facetLabelFor(service.facet) : "",
    service.metric && !active.has(service.metric) ? facetLabelFor(service.metric) : "",
    service.quality,
  ]
    .filter(Boolean)
    .join(" · ");
  return el(
    "button",
    { class: "pick", onClick: () => void chooseService(service) },
    el("span", { class: "pick-title" }, service.title),
    meta ? el("span", { class: "pick-meta" }, meta) : null,
    el("span", { class: "grow" }),
    service.price ? el("span", { class: "pick-price" }, service.price) : null,
  );
}

function pager(): HTMLElement | null {
  const cat = catalogState();
  const pages = pageCount(cat.total, cat.pageSize);
  if (!pages || pages < 2) return null;
  // The list holds a bounded number of pages on purpose. Past that the honest answer is to search,
  // not to offer page 4,000.
  const capped = cat.total !== null && Math.ceil(cat.total / cat.pageSize) > pages;

  return el(
    "div",
    { class: "pager" },
    el("button", { class: "sm quiet", disabled: cat.page <= 1, onClick: () => refreshSoon(cat.page - 1) }, "Previous"),
    el("span", { class: "help" }, `Page ${cat.page} of ${pages}${capped ? "+" : ""}`),
    el("button", { class: "sm quiet", disabled: cat.page >= pages, onClick: () => refreshSoon(cat.page + 1) }, "Next"),
    capped ? el("span", { class: "help" }, "Search or filter to reach the rest.") : null,
  );
}

function variantCard(service: ChosenService): HTMLElement {
  const s = state();
  const { options, express } = s.choice;
  // Collapse only when there is something to collapse AND something to collapse to. Three options
  // are not noise, and hiding them behind a disclosure would be ceremony.
  const collapsible = express.length > 0 && (options?.length ?? 0) > FULL_LIST_THRESHOLD;
  const showingAll = !collapsible || s.choice.showAllOptions;

  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el("h3", {}, service.title || service.id),
      el("div", { class: "grow" }),
      el(
        "button",
        {
          class: "sm quiet",
          onClick: () => {
            s.choice = emptyChoice();
            render();
          },
        },
        "Back to the catalog",
      ),
    ),
    el(
      "div",
      { class: "card-body" },
      s.optionsError ? el("p", { class: "help" }, s.optionsError) : null,
      options === null ? el("p", { class: "help" }, "Reading the setups...") : null,
      options?.length === 0 ? el("p", { class: "help" }, "This one has no variants; continue to the request.") : null,

      options && collapsible && !showingAll ? expressList(express, options.length) : null,
      options?.length && showingAll ? fullList(options, collapsible) : null,
    ),
    el(
      "div",
      { class: "card-foot" },
      el("button", { class: "primary", onClick: () => goTo("request") }, "Continue"),
      el("span", { class: "help" }, "Your choice fills the request fields. You can still edit them."),
    ),
  );
}

// The endpoint's own recommended setups. These are not a sample of the list: the seller computes
// them per service and keeps them current, and they are what its own storefront sells.
function expressList(express: ExpressPick[], total: number): HTMLElement {
  const s = state();
  return el(
    "div",
    COLUMN,
    el(
      "div",
      { class: "pick-list" },
      ...express.map((entry) =>
        el(
          "button",
          {
            class: `pick tall ${s.choice.option?.id === entry.option.id ? "on" : ""}`,
            onClick: () => chooseOption(entry.option),
          },
          el(
            "span",
            { class: "pick-body" },
            el("span", { class: "pick-title" }, entry.label),
            el("span", { class: "pick-meta" }, optionMeta(entry.option, entry.subtitle)),
          ),
          entry.option.price ? el("span", { class: "pick-price" }, entry.option.price) : null,
        ),
      ),
    ),
    el(
      "div",
      { class: "count-line" },
      el("span", {}, `${express.length} of ${total} setups, the ones this endpoint recommends`),
      el("div", { class: "grow" }),
      el(
        "button",
        {
          class: "sm quiet",
          onClick: () => {
            s.choice.showAllOptions = true;
            render();
          },
        },
        `Show all ${total}`,
      ),
    ),
  );
}

// Everything the service publishes, with a filter over it.
//
// Filtering here is honest in a way the catalog's could not be: one request returns every option a
// service has, so this holds the whole list and "12 of 92" is a fact about the service rather than
// about what happened to be downloaded. The catalog filters at the endpoint for exactly that
// reason, and the difference is worth keeping straight.
function fullList(options: CatalogOption[], collapsible: boolean): HTMLElement {
  const s = state();
  const query = s.choice.optionQuery.trim().toLowerCase();
  const shown = query
    ? options.filter((option) => `${option.label} ${option.quality ?? ""}`.toLowerCase().includes(query))
    : options;
  const long = options.length > FULL_LIST_THRESHOLD;

  return el(
    "div",
    COLUMN,
    long
      ? el("input", {
          id: "optionFilter",
          type: "search",
          autocomplete: "off",
          placeholder: "Filter these setups",
          value: s.choice.optionQuery,
          onInput: (event: Event) => {
            if (!(event.target instanceof HTMLInputElement)) return;
            s.choice.optionQuery = event.target.value;
            s.choice.optionCaret = event.target.selectionStart;
            s.choice.optionFocused = true;
            filterOptionsSoon();
          },
          onFocus: () => {
            s.choice.optionFocused = true;
          },
          onBlur: () => {
            s.choice.optionFocused = false;
          },
        })
      : null,

    long
      ? el(
          "div",
          { class: "count-line" },
          el("span", {}, query ? `${shown.length} of ${options.length}` : `All ${options.length}, read in one request`),
          el("div", { class: "grow" }),
          collapsible
            ? el(
                "button",
                {
                  class: "sm quiet",
                  onClick: () => {
                    s.choice.showAllOptions = false;
                    s.choice.optionQuery = "";
                    render();
                  },
                },
                "Show the recommended ones",
              )
            : null,
        )
      : null,

    shown.length
      ? el(
          "div",
          { class: "pick-list" },
          ...shown.map((option) =>
            el(
              "button",
              {
                class: `pick ${s.choice.option?.id === option.id ? "on" : ""}`,
                onClick: () => chooseOption(option),
              },
              el("span", { class: "pick-title" }, option.label),
              el("span", { class: "pick-meta" }, optionMeta(option)),
              el("span", { class: "grow" }),
              option.price ? el("span", { class: "pick-price" }, option.price) : null,
            ),
          ),
        )
      : el("p", { class: "help" }, "Nothing here matches that."),
  );
}

function optionMeta(option: CatalogOption, subtitle?: string): string {
  // The preset's subtitle and the option's own quality name are often the same words, because both
  // describe the same setup. Printing them twice reads as a rendering bug, which is what it is.
  const parts = [
    subtitle,
    option.quality,
    option.min ? `from ${option.min}` : null,
    option.max ? `up to ${option.max}` : null,
    option.startLabel ? `starts ${option.startLabel}` : null,
    option.linkType ? `${option.linkType} link` : null,
    option.requiresPosts ? "per post, needs a post count" : null,
  ];
  const seen = new Set<string>();
  return parts
    .filter((part): part is string => Boolean(part))
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" · ");
}

const filterOptionsSoon = debounce(() => {
  render();
  const { choice } = state();
  restoreFocus("optionFilter", choice.optionFocused, choice.optionCaret);
}, 200);
