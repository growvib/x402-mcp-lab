// Paying out of the balance the endpoint already holds.
//
// This is the path that exists because the endpoint has a minimum payment: an order cheaper than
// the minimum leaves the difference behind, and without a way to spend it every order settles
// again. The thing worth asserting is what does NOT happen: no signature is taken for a payment,
// no payment header is sent, and a second press with the same selection does not buy twice.

import type { Page } from "playwright";

import { assert, connectWallet, inLab, text, typedSignatures, waitInLab, withLab } from "./harness.ts";

const balanceBadge = (): string => document.getElementById("balanceBadge")?.textContent ?? "";

// Connecting is the whole sign-in. A source that publishes a wallet sign-in is asked for the
// balance as soon as there is a wallet to ask about, because a page that cannot answer "what do I
// have here?" until you find a button on the third step reads as a page with no balance in it.
async function connect(page: Page): Promise<void> {
  await connectWallet(page);
  await waitInLab(page, ({ app }) => app.agentToken !== null);
}

// refuseSigning makes personal_sign fail the way a person declining the wallet dialog does,
// leaving every other wallet call alone. Installed before connecting, it is how a spec gets to the
// state where no credential has been obtained.
async function refuseSigning(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__refuseSign = true;
    const wallet = window.ethereum;
    if (!wallet) throw new Error("the stub wallet is not installed");
    const real = wallet.request.bind(wallet);
    wallet.request = async (args) => {
      if (window.__refuseSign && args.method === "personal_sign") throw new Error("User rejected the request");
      return real(args);
    };
  });
}

function signAgain(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.__refuseSign = false;
  });
}

async function toQuote(page: Page): Promise<void> {
  await page.waitForSelector(".pick");
  await page.click(".pick:has-text('Sample report')");
  await page.waitForSelector(".pick:has-text('Standard')");
  await page.click(".pick:has-text('Standard')");
  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=Your payment quote");
}

await withLab("balance: connecting reads the balance, then an order spends it with no signature", async ({ page }) => {
  await connect(page);

  // Signing in is a signature over a message, not a payment: personal_sign, nothing typed, nothing
  // on chain.
  const balance = await inLab(page, ({ app }) => app.agentBalance);
  assert(balance === 1.86, `the balance the endpoint reported did not reach the page: ${balance}`);
  assert((await typedSignatures(page)) === 0, "signing in took a payment authorization");

  await toQuote(page);

  // The quote is anonymous on purpose: on this endpoint a bearer token with no payment IS the
  // order, so carrying one here would place an order while asking the price.
  const quoteRequest = await inLab(page, ({ app }) => app.run?.entries.find((entry) => entry.status === 402));
  assert(quoteRequest, "no 402 was recorded for the quote");

  await page.waitForSelector("text=from your balance here");
  assert(
    /1.86 spendable/.test(await text(page, ".card:has-text('from your balance here')")),
    "the balance is not shown beside the quote",
  );

  await page.click("button:has-text('from balance')");
  await page.waitForSelector("text=Delivered, paid from your balance");

  const view = await text(page, "#view");
  assert(/Charged to your balance/.test(view), "the result does not say the balance was charged");
  assert(/\$0\.01/.test(view), `the amount actually charged is not on the screen: ${view.slice(0, 400)}`);
  assert(/\$1\.85 left/.test(view), "what is left on the endpoint is not on the screen");
  assert((await typedSignatures(page)) === 0, "a balance order opened the wallet for a signature");
  assert(
    await inLab(page, ({ pg }) => pg.payload === null || pg.payload === undefined),
    "a payment payload was built for an order that needed none",
  );

  // The endpoint's fresh token and the balance it left are both taken from the response.
  assert((await inLab(page, ({ app }) => app.agentBalance)) === 1.85, "the new balance did not reach the page");
});

await withLab("balance: both routes are buttons in the same row", async ({ page }) => {
  await connect(page);
  await toQuote(page);

  // Two routes to one order belong side by side. They were two cards, and the one that would
  // actually have placed the order sat off the bottom of the screen while the action row showed a
  // blocked button: "there is no button to pay from balance" is what that looked like.
  const foot = await page.$$eval(".card-foot button", (nodes) => nodes.map((node) => (node.textContent ?? "").trim()));
  assert(
    foot.some((label) => /Pay from balance/.test(label)),
    `the balance route is not in the action row: ${foot.join(" | ")}`,
  );
  assert(
    foot.some((label) => /Pay |Blocked/.test(label)),
    `the settling route left the action row: ${foot.join(" | ")}`,
  );
  assert(
    foot.some((label) => /Sign without sending/.test(label)),
    "the dry run left the action row",
  );

  // And one card, not two.
  const headings = await page.$$eval(".card h3", (nodes) => nodes.map((node) => node.textContent ?? ""));
  assert(
    !headings.some((heading) => /from your balance/i.test(heading)),
    `the balance route is still a card of its own: ${headings.join(" | ")}`,
  );
  assert(await page.isVisible("text=Pay from your balance here"), "the balance route lost its explanation");
});

await withLab("balance: the same order twice does not buy twice", async ({ page }) => {
  await connect(page);
  await toQuote(page);
  await page.click("button:has-text('from balance')");
  await page.waitForSelector("text=Delivered, paid from your balance");
  const first = await inLab(page, ({ pg }) => pg.firstOrderId);
  assert(first, "the first order has no id");

  // Round two, same selection. The key is derived from what is being bought, so the endpoint
  // answers with the order it already placed rather than charging again.
  await page.click("button:has-text('Start another')");
  await page.click("button:has-text('Continue')");
  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=from your balance here");
  await page.click("button:has-text('from balance')");
  await page.waitForSelector("text=Delivered, paid from your balance");

  const view = await text(page, "#view");
  assert(view.includes(first), `a second order was placed: expected ${first} in the result`);
  assert(/\$1\.85 left/.test(view), "the balance moved on a repeat of the same order");
});

await withLab("balance: the endpoint decides whether the balance covers it, not the page", async ({ page }) => {
  await connect(page);

  // A quantity no balance here can buy.
  await page.waitForSelector(".pick");
  await page.click(".pick:has-text('Sample report')");
  await page.waitForSelector(".pick:has-text('Standard')");
  await page.click(".pick:has-text('Standard')");
  await inLab(page, ({ pg }) => {
    pg.body = { item: "sample-report", variant: "standard", quantity: 9999 };
    pg.form = null;
  });
  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=from your balance here");

  // The quoted amount is this endpoint's MINIMUM, not the order's price, so a balance under it is
  // not a refusal and the page does not pretend to know. It says so and offers the button anyway.
  const card = await text(page, ".card:has-text('from your balance here')");
  assert(/minimum rather than this order's price/.test(card), `the page treated the quote as the price: ${card}`);
  assert(
    !(await page.locator("button:has-text('Pay from balance')").isDisabled()),
    "the page refused an order the endpoint had not been asked about",
  );

  // And when the endpoint does refuse, that is an answer: nothing is charged and the paying path
  // is still open.
  await page.click("button:has-text('Pay from balance')");
  await page.waitForSelector(".callout.bad");
  const refusal = await text(page, ".callout.bad");
  assert(/does not cover|payment/i.test(refusal), `the refusal was not explained: ${refusal}`);
  assert((await inLab(page, ({ pg }) => pg.result)) == null, "a refused balance order was reported as a result");
  assert(await page.isVisible("#paySettleButton"), "the paying path was taken away after a balance refusal");
});

await withLab("balance: a live network places the order on the first press", async ({ page }) => {
  await connect(page);
  await toQuote(page);

  // The demo server relabelled as a live source. The review card already states the amount, the
  // network and the recipient, so a second "this is real money" step in front of the button was
  // removed as redundant: one press places the order.
  await inLab(page, ({ app }) => {
    if (app.target) app.target.environment = "mainnet";
  });
  await page.click("button:has-text('from balance')");
  await page.waitForSelector("text=Delivered, paid from your balance");
  assert((await page.locator("text=This is real money").count()) === 0, "a mainnet acknowledgement banner came back");
});

await withLab("balance: one button, from no credential to a placed order", async ({ page }) => {
  // Declining the signature on connect is a reasonable answer, and it leaves the page in the state
  // this spec is about: a wallet, no credential, and no second button to find first.
  await refuseSigning(page);
  await connectWallet(page);
  await toQuote(page);

  assert((await inLab(page, ({ app }) => app.agentToken)) === null, "the run started with a token");
  // Scoped to the view: the Source drawer keeps a sign-in of its own, which is fine. What must not
  // exist is a step between "I want to pay from my balance" and the order.
  assert(
    (await page.locator("#view button:has-text('Sign in with this wallet')").count()) === 0,
    "the review step still asks for a separate sign-in press",
  );

  await signAgain(page);
  await page.click("button:has-text('Pay from balance')");
  await page.waitForSelector("text=Delivered, paid from your balance");

  // It got its own credential on the way through, and the order was charged to the balance.
  assert((await inLab(page, ({ app }) => app.agentToken)) !== null, "no credential was obtained");
  assert(/Charged to your balance/.test(await text(page, "#view")), "the order did not come out of the balance");
  assert((await typedSignatures(page)) === 0, "a typed-data payment authorization was taken");
});

await withLab("balance: a refused signature stops before the gate", async ({ page }) => {
  await refuseSigning(page);
  await connectWallet(page);
  await toQuote(page);

  // Somebody who rejects the signature has not paid for anything and has not spent a payment slot.
  await page.click("button:has-text('Pay from balance')");
  await page.waitForSelector(".callout.bad");
  assert(/rejected/i.test(await text(page, ".callout.bad")), "the refusal was not reported");
  assert((await inLab(page, ({ pg }) => pg.result)) == null, "an order was placed anyway");

  // And the gate was never entered, so the next attempt is not held behind a cooldown. Proving it
  // by trying again is better than reading a counter: the counter is what the gate says, and this
  // is what the gate does.
  await signAgain(page);
  await page.click("button:has-text('Pay from balance')");
  await page.waitForSelector("text=Delivered, paid from your balance", { timeout: 10000 });
});

await withLab("balance: the balance is in the top bar, before anybody goes looking", async ({ page }) => {
  // Nothing is claimed before there is a wallet to claim it for: the badge is not a guess.
  assert(await page.locator("#balanceBadge").isHidden(), "a balance was offered before a wallet was connected");

  await connect(page);

  // No quote, no card, no scrolling. Connecting was the whole thing.
  await page.waitForSelector("#balanceBadge:not([hidden])");
  const badge = await text(page, "#balanceBadge");
  assert(/\$1\.86 balance/.test(badge), `the top bar does not carry the balance: ${badge}`);

  await toQuote(page);
  await page.click("button:has-text('Pay from balance')");
  await page.waitForSelector("text=Delivered, paid from your balance");
  await page.waitForFunction(() => /1\.85/.test(document.getElementById("balanceBadge")?.textContent ?? ""));
});

await withLab("balance: a declined sign-in leaves the badge offering it again", async ({ page }) => {
  await refuseSigning(page);
  await connectWallet(page);

  // The automatic attempt asked without being told to, so a refusal is not an error in red. What
  // it must not be is silence: the badge says the balance is unread and that pressing asks again.
  await page.waitForSelector("#balanceBadge:not([hidden])");
  const offer = await page.evaluate(balanceBadge);
  assert(/balance/i.test(offer), `the badge does not offer the balance: ${offer}`);
  assert((await inLab(page, ({ app }) => app.agentToken)) === null, "a refused signature produced a token");

  await signAgain(page);
  await page.click("#balanceBadge");
  await page.waitForFunction(() => /1\.86 balance/.test(document.getElementById("balanceBadge")?.textContent ?? ""));
});

await withLab("balance: no warning about a warning the wallet will not give", async ({ page }) => {
  // The endpoint names the page that asked for the signature (it reads the Origin the lab's proxy
  // forwards), so an honest sign-in gets no domain warning and the page must not invent one. The
  // version that warned every time taught people to click through the real thing.
  await refuseSigning(page);
  await connectWallet(page);
  await waitInLab(page, ({ app }) => app.signInAuthority !== null);

  const named = await inLab(page, ({ app }) => app.signInAuthority);
  const host = await page.evaluate(() => window.location.host);
  assert(named === host, `the message named ${named}, not this page (${host})`);

  await toQuote(page);
  const card = await text(page, ".card:has-text('from your balance here')");
  assert(!/domain mismatch/i.test(card), `a mismatch was explained where there is none: ${card}`);
});

await withLab("balance: a real domain mismatch is explained while the wallet is asking", async ({ page }) => {
  await refuseSigning(page);
  await connectWallet(page);
  await toQuote(page);

  // An endpoint that names something else is the case the warning exists for: a wallet shows a red
  // flag on a prompt about money, and meeting that for the first time inside the wallet reads as an
  // attack. The fixture is asked to name another host, the way a deployment we are not first party
  // to would.
  await inLab(page, ({ app }) => {
    const auth = app.target?.walletAuth;
    if (auth) auth.challenge = "/v1/agent/auth/challenge?domain=api.example.com";
  });
  await page.click("button:has-text('Pay from balance')");
  await page.waitForSelector("text=domain mismatch");

  const card = await text(page, ".card:has-text('from your balance here')");
  assert(/api\.example\.com/.test(card), `the explanation does not name what the message named: ${card}`);
  assert(/localhost/.test(card), `the explanation does not name the page it is served from: ${card}`);
  assert(/moves no funds/.test(card), "the explanation does not say what the message itself says");
});
