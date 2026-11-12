// Paying on the Solana rail.
//
// A quote can offer more than one network, and on this one the payer signs the transfer itself
// rather than an authorization to make one. That is a different wallet, a different payload and a
// transaction this page assembles byte by byte, so what these check is that choosing the rail
// changes what is asked for, and that what goes over the wire is a transaction and not a
// signature with a Solana label on it.
//
// The bytes themselves are checked twice elsewhere and not here: against the server's own Go
// parser (wireshape) and against a real mainnet token account (test/unit/solana.test.ts).

import type { Page } from "playwright";

import { assert, inLab, text, typedSignatures, withLab } from "./harness.ts";

async function toQuote(page: Page): Promise<void> {
  await page.waitForSelector(".pick");
  await page.click(".pick:has-text('Sample report')");
  await page.waitForSelector(".pick:has-text('Standard')");
  await page.click(".pick:has-text('Standard')");
  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=Your payment quote");
}

const networkButtonSays = (want: string): boolean =>
  document.getElementById("networkButton")?.textContent?.includes(want) ?? false;

// The rails are chosen from the top bar now, through the same dialog the wallet picker uses.
async function switchTo(page: Page, network: string): Promise<void> {
  await page.click("#networkButton");
  await page.waitForSelector("dialog.picker[open]");
  await page.click(`dialog.picker .pick:has-text('${network}')`);
  await page.waitForFunction(networkButtonSays, network);
}

function solanaCalls(page: Page) {
  return page.evaluate(() => window.__solanaCalls ?? []);
}

await withLab(
  "solana: a second rail is offered by name, not by genesis hash",
  async ({ page }) => {
    await toQuote(page);

    // CAIP-2 names a Solana cluster by 32 characters of its genesis hash. That is what the endpoint
    // sends and it is not what a person should be asked to choose between.
    // In the top bar, beside the wallet, because which network is selected is the state of the
    // session and not a detail of one card.
    assert(await page.isVisible("#networkButton"), "the network is not in the top bar");
    assert(/Base/.test(await text(page, "#networkButton")), "the top bar does not name the selected network");
    assert((await page.locator("#networkButton .netmark").count()) > 0, "the network has no mark beside its name");

    await page.click("#networkButton");
    await page.waitForSelector("dialog.picker[open]");
    const rails = await page.$$eval("dialog.picker .pick-title", (nodes) =>
      nodes.map((node) => (node.textContent ?? "").trim()),
    );
    assert(rails.includes("Base"), `the Base rail is not offered by name: ${rails.join(" | ")}`);
    assert(rails.includes("Solana"), `the Solana rail is not offered by name: ${rails.join(" | ")}`);
    assert(!rails.some((label) => label.includes("5eykt4")), `a genesis hash is on a button: ${rails.join(" | ")}`);
    // The exact id is still there, under the name, because this is a lab.
    const subs = await page.$$eval("dialog.picker .pick-meta", (nodes) =>
      nodes.map((node) => (node.textContent ?? "").trim()),
    );
    assert(
      subs.some((sub) => sub.startsWith("solana:5eykt4")),
      `the CAIP-2 id is not offered anywhere: ${subs.join(" | ")}`,
    );
    await page.click("dialog.picker .pick:has-text('Solana')");
    // Switching re-reads the facts for the new rail before it re-renders, so the card is still the
    // old one for a moment. Waiting on the top bar is waiting for that render to have happened;
    // reading the card without it passes or fails on timing, which is what it did.
    await page.waitForFunction(networkButtonSays, "Solana");
    const network = await text(page, ".metrics");
    assert(/Solana/.test(network), "the network row does not name the chain");
    // The full id stays on the page, under the name: this is a lab, and the exact string is the
    // thing somebody came here to copy.
    assert(/solana:5eykt4/.test(network), "the CAIP-2 id is gone, and it is what a client has to send");
  },
  { solana: true },
);

await withLab(
  "solana: the wallet signs a transaction, and a transaction is what is sent",
  async ({ page }) => {
    await toQuote(page);
    await switchTo(page, "Solana");
    await page.waitForSelector("#paySettleButton");

    await page.click("#paySettleButton");
    await page.waitForSelector("text=Delivered", { timeout: 15000 });

    // The wallet was asked for a transaction signature, not a typed-data one: those are different
    // instruments and only one of them moves tokens on Solana.
    const calls = await solanaCalls(page);
    assert(
      calls.some((call) => call.method === "connect"),
      "the Solana wallet was never connected",
    );
    assert(
      calls.some((call) => call.method === "signTransaction"),
      `no transaction was signed: ${JSON.stringify(calls)}`,
    );
    assert((await typedSignatures(page)) === 0, "the EVM wallet was opened for a Solana payment");

    // And the payload carries the transaction where the server reads it, with no EVM fields left
    // over from the other rail.
    const payload = await inLab(page, ({ pg }) => pg.payload);
    assert(payload, "no payload was built");
    const network = payload.accepted.network ?? "";
    assert(network.startsWith("solana:"), `the payload names ${network}`);
    const carried = (payload.payload ?? {}) as { transaction?: unknown; signature?: unknown; authorization?: unknown };
    assert(
      typeof carried.transaction === "string" && carried.transaction.length > 200,
      `the payload carries no transaction: ${JSON.stringify(carried).slice(0, 200)}`,
    );
    assert(
      !carried.signature && !carried.authorization,
      "the Solana payload carries EVM fields, which the server would read as a different scheme",
    );
  },
  { solana: true },
);

await withLab(
  "solana: a refused signature pays nothing and leaves the rail usable",
  async ({ page }) => {
    await toQuote(page);
    await switchTo(page, "Solana");
    await page.waitForSelector("#paySettleButton");

    await page.evaluate(() => {
      window.__refuseSolanaSign = true;
    });
    await page.click("#paySettleButton");
    await page.waitForSelector(".callout.bad", { timeout: 15000 });
    assert(/rejected/i.test(await text(page, ".callout.bad")), "the refusal was not reported");
    assert((await inLab(page, ({ pg }) => pg.result)) == null, "an order was reported for a refused signature");

    // Pressing again works, which is the only way to show the gate was left as it was found.
    await page.evaluate(() => {
      window.__refuseSolanaSign = false;
    });
    await page.click("#paySettleButton");
    await page.waitForSelector("text=Delivered", { timeout: 15000 });
  },
  { solana: true },
);

await withLab(
  "solana: a wallet that returns different bytes than it was given is refused",
  async ({ page }) => {
    await toQuote(page);
    await switchTo(page, "Solana");
    await page.waitForSelector("#paySettleButton");

    // The wallet is handed bytes and returns bytes, and nothing but the page compares the two. A
    // wallet (or anything sitting between) that rewrote the transfer would otherwise be signing
    // something the payer never saw, and this page would post it.
    await page.evaluate(() => {
      window.__mangleSolanaSign = true;
    });
    await page.click("#paySettleButton");
    await page.waitForSelector(".callout.bad", { timeout: 15000 });

    const refusal = await text(page, ".callout.bad");
    assert(/different transaction/.test(refusal), `the substitution was not caught: ${refusal}`);
    assert((await inLab(page, ({ pg }) => pg.payload)) == null, "the mangled transaction became a payload");
    assert((await inLab(page, ({ pg }) => pg.result)) == null, "the mangled transaction was sent");
  },
  { solana: true },
);

await withLab("solana: with no Solana wallet the rail says so instead of offering a dead button", async ({ page }) => {
  await toQuote(page);
  await switchTo(page, "Solana");
  await page.waitForSelector("#paySettleButton");

  assert(await page.locator("#paySettleButton").isDisabled(), "a payment was offered with no wallet to make it");
  const foot = await text(page, ".card-foot");
  assert(/No Solana wallet found/.test(foot), `the row does not say why: ${foot}`);
});

await withLab(
  "solana: a quote with no fee payer is unpayable, and says which part is missing",
  async ({ page }) => {
    // The facilitator supplies the fee payer and the blockhash, and without them nobody can build
    // this transaction: not this lab, not an agent, not the reference client. The flaw goes on the
    // paid resource only, so the catalog steps before it still work.
    await page.waitForSelector(".pick");
    await page.click(".pick:has-text('Sample report')");
    await page.waitForSelector(".pick:has-text('Standard')");
    await page.click(".pick:has-text('Standard')");
    await inLab(page, ({ app }) => {
      if (app.target) app.target.resource += "?flaws=solana-no-fee-payer";
    });
    await page.click("button:has-text('Get payment quote')");
    await page.waitForSelector("text=Your payment quote");
    await switchTo(page, "Solana");
    await page.waitForSelector("#paySettleButton");

    // The check for it fails, by name, so the reason is on the page before anybody presses anything.
    assert(/feePayer/.test(await text(page, "#view")), "nothing on the page names the missing field");
    const button = page.locator("#paySettleButton");
    assert(((await button.textContent()) ?? "").includes("Blocked"), "the button does not read as blocked");
    assert(await button.isDisabled(), "a payment was offered for a quote that cannot be built");

    // Forced past the disabled attribute, because the guard that matters lives in the handler: a
    // dispatched click reaches it whatever the markup says.
    await button.dispatchEvent("click");
    await page.waitForSelector(".callout.bad", { timeout: 15000 });
    const refusal = await text(page, ".callout.bad");
    assert(/feePayer/.test(refusal), `the forced click was not refused by name: ${refusal}`);
    assert((await solanaCalls(page)).length === 0, "a wallet was opened for a quote that could never have been paid");
    assert((await inLab(page, ({ pg }) => pg.payload)) == null, "a payload was built anyway");
  },
  { solana: true },
);
