// The catalog step against a catalog big enough to need one.
//
// The demo server publishes forty products across four categories, which is the smallest size at
// which the difference between "filtering what I downloaded" and "asking the endpoint" is visible.
// Every assertion here is about that difference: the count line has to describe the catalog, not
// the page.

import { assert, inLab, text, withLab } from "./harness.ts";

const countLine = (): string => document.querySelector(".count-line")?.textContent ?? "";
const countLineMatches = (pattern: string): boolean =>
  new RegExp(pattern).test(document.querySelector(".count-line")?.textContent ?? "");

await withLab("catalog: search, filter and page against the endpoint", async ({ page }) => {
  await page.waitForSelector(".pick");

  // One page of twelve out of forty, and the line says both numbers.
  const first = await page.evaluate(countLine);
  assert(/Showing 1-12 of 40/.test(first), `the count line read: ${first}`);
  assert((await page.locator(".pick").count()) === 12, "the first page did not hold twelve rows");

  // Search goes to the endpoint: the total moves, which it could not do if this were filtering the
  // twelve rows already on the page.
  await page.fill("#catalogSearch", "export");
  await page.waitForFunction(countLineMatches, "of 10");
  const searched = await page.evaluate(countLine);
  assert(/"export"/.test(searched), `the count line did not name the search: ${searched}`);

  // Clearing puts the whole catalog back.
  await page.click(".count-line button:has-text('Clear')");
  await page.waitForFunction(countLineMatches, "of 40");

  // A facet chip is the endpoint's own vocabulary, with the endpoint's own counts.
  await page.click(".chip:has-text('Media')");
  await page.waitForFunction(countLineMatches, "of 10");
  const filters = await inLab(page, ({ pg }) => pg.cat.filters);
  assert(filters.category === "media", `the filter did not reach the request: ${JSON.stringify(filters)}`);

  // Paging asks for the next page rather than growing the list.
  await page.click(".count-line button:has-text('Clear')");
  await page.waitForFunction(countLineMatches, "of 40");
  const before = await text(page, ".pick .pick-title");
  await page.click(".pager button:has-text('Next')");
  await page.waitForFunction(countLineMatches, "Showing 13-24");
  assert((await text(page, ".pick .pick-title")) !== before, "the next page rendered the same first row");
  assert((await page.locator(".pick").count()) === 12, "the second page did not replace the first");

  // A search with no answer says so, and offers the way out rather than an empty box.
  await page.click(".pager button:has-text('Previous')");
  // Wait for that page to land before typing: filling an input that a render is about to replace
  // fills the node on its way out, and the search never happens.
  await page.waitForFunction(countLineMatches, "Showing 1-12");
  await page.fill("#catalogSearch", "nothing matches this");
  await page.waitForSelector(".empty");
  assert(/Nothing in this catalog matches/.test(await text(page, ".empty")), "the empty state did not explain itself");
  await page.click(".empty button:has-text('Clear the search')");
  await page.waitForSelector(".pick");

  // The choice still reaches the request body, which is the only reason any of this exists.
  await page.click(".pick:has-text('Sample report')");
  await page.waitForSelector(".pick:has-text('Priority')");
  await page.click(".pick:has-text('Priority')");
  const body = await inLab(page, ({ pg }) => pg.body);
  assert(
    body?.item === "sample-report" && body.variant === "priority",
    `the choice did not fill the request: ${JSON.stringify(body)}`,
  );
});
