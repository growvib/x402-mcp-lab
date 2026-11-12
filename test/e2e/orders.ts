// Reading an order back after it is placed: the result step's live status and refresh, and the
// Orders page.
//
// The placing response always says PENDING, and it cannot say what the order was placed AS. A
// "High Quality" order the endpoint placed as "Standard" read as a clean success until the lab
// asked the endpoint's order read. The fixture moves an order one status per read, so a refresh
// that really re-read something is visible as a changed status.

import type { Page } from "playwright";

import { assert, connectWallet, inLab, type Lab, text, waitInLab, withLab } from "./harness.ts";

async function connect(page: Page): Promise<void> {
  await connectWallet(page);
  await waitInLab(page, ({ app }) => app.agentToken !== null);
}

async function placeFromBalance(page: Page): Promise<void> {
  await page.waitForSelector(".pick");
  await page.click(".pick:has-text('Sample report')");
  await page.waitForSelector(".pick:has-text('Standard')");
  await page.click(".pick:has-text('Standard')");
  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=Your payment quote");
  await page.click("button:has-text('Pay from balance')");
  await page.waitForSelector("text=Delivered, paid from your balance");
}

// Each runs in the page, so each spells its pattern out rather than sharing one from here.
const orderReads = ({ app }: Lab): number =>
  (app.run?.entries ?? []).filter((entry) => entry.method === "GET" && /\/v1\/agent\/orders\//.test(entry.url)).length;
const listReads = ({ app }: Lab): number =>
  (app.run?.entries ?? []).filter((entry) => entry.method === "GET" && /\/v1\/agent\/orders\?/.test(entry.url)).length;

await withLab("orders: the result reads the order back, and refresh reads it again", async ({ page }) => {
  await connect(page);
  await placeFromBalance(page);

  // Read once on arrival, without a press: the snapshot said PENDING, the read says what is true.
  await page.waitForSelector("#liveOrder >> text=In progress");
  const live = await text(page, "#liveOrder");
  assert(/Sample report · Standard/.test(live), `the live status does not say what the order was placed as: ${live}`);
  assert((await inLab(page, orderReads)) === 1, "the order was not read exactly once on arrival");
  assert((await page.locator("#optionMismatch").count()) === 0, "a matching option was reported as a mismatch");

  await page.click("#refreshStatusButton");
  await page.waitForSelector("#liveOrder >> text=Completed");
  assert((await inLab(page, orderReads)) === 2, "refresh did not read the order again");

  // Every read is a GET with the token and nothing that could pay.
  const bodies = await inLab(page, ({ app }) =>
    (app.run?.entries ?? [])
      .filter((entry) => entry.method === "GET" && /\/v1\/agent\/orders/.test(entry.url))
      .map((entry) => entry.request === undefined),
  );
  assert(bodies.every(Boolean), "an order read carried a body");
});

await withLab("orders: an order placed as a different option than the one chosen says so", async ({ page }) => {
  await connect(page);
  await placeFromBalance(page);
  await page.waitForSelector("#liveOrder >> text=In progress");

  // As if the endpoint had ignored the choice: the page chose one option, the order read names
  // another. This is the order a0f8ba4e case, which the result screen used to call a success.
  await inLab(page, ({ pg }) => {
    if (pg.choice.option) pg.choice.option.label = "High Quality";
  });
  await page.click("#refreshStatusButton");
  await page.waitForSelector("#optionMismatch");
  const warning = await text(page, "#optionMismatch");
  assert(
    /You chose High Quality.*placed this order as Standard/.test(warning),
    `the mismatch is not explained: ${warning}`,
  );
});

await withLab("orders: the Orders page lists the wallet's orders and refreshes one", async ({ page }) => {
  await connect(page);
  await placeFromBalance(page);

  await page.click(".nav[data-route='orders']");
  await page.waitForSelector("#ordersList .order-row");
  const count = await page.locator("#ordersList .order-row").count();
  assert(count >= 1, "the placed order is not listed");
  assert(/Showing 1-\d+ of \d+/.test(await text(page, ".count-line")), "the list does not say how many there are");

  await page.click("#ordersList .order-row >> nth=0");
  await page.waitForSelector(".order-detail");
  const before = await text(page, ".order-detail");
  await page.click("button:has-text('Refresh this order')");
  await page.waitForFunction((was) => document.querySelector(".order-detail")?.textContent !== was, before);
  assert(/Completed|In progress/.test(await text(page, ".order-detail")), "the refreshed order shows no status");

  // The page-level refresh re-reads the list.
  const was = await inLab(page, listReads);
  await page.click("#ordersRefresh");
  await waitInLab(
    page,
    ({ app }, n) =>
      (app.run?.entries ?? []).filter((entry) => entry.method === "GET" && /\/v1\/agent\/orders\?/.test(entry.url))
        .length > n,
    was,
  );
});

await withLab("orders: with no agent token the page offers the sign-in, not an empty list", async ({ page }) => {
  await page.click(".nav[data-route='orders']");
  await page.waitForSelector("button:has-text('Sign in with this wallet')");
  assert((await page.locator("#ordersList").count()) === 0, "a list was drawn with no token to read it with");
});
