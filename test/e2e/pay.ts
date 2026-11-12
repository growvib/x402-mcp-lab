// The whole flow, driven the way a person drives it: choose, request, review, pay, replay.

import { assert, connectWallet, inLab, PAY_TO, text, waitInLab, withLab } from "./harness.ts";

await withLab("pay: choose, quote, review, settle, replay", async ({ page }) => {
  await connectWallet(page);

  // Step one is the catalog the endpoint itself publishes.
  await page.click(".pick:has-text('Sample report')");
  await page.waitForSelector(".pick:has-text('Priority')");
  await page.click(".pick:has-text('Priority')");

  // The choice reaches the request body under the field names the source declares.
  const body = await inLab(page, ({ pg }) => pg.body);
  assert(
    body?.item === "sample-report" && body.variant === "priority",
    `the choice did not fill the request: ${JSON.stringify(body)}`,
  );

  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=Your payment quote");

  // The variant chosen decides the price, so the quote has to move with it.
  const amount = await text(page, ".amount");
  assert(/0\.05/.test(amount) && /USDC/.test(amount), `the quote rendered ${amount}`);

  // Pinning the recipient is done next to the payment, not in a settings panel elsewhere.
  await page.fill("#guardPayTo", PAY_TO);
  await waitInLab(page, ({ app }) => app.guards.expectedPayTo.length === 42);

  // Passing checks are a count, not ten rows.
  const strip = await text(page, ".check-strip");
  assert(/All \d+ payment checks passed/.test(strip), `the check summary reads "${strip}"`);

  const payButton = page.locator("#paySettleButton");
  assert(((await payButton.textContent()) ?? "").includes("0.05 USDC"), "the amount is not on the button");
  await payButton.click();
  await page.waitForSelector("text=Paid and delivered");

  // Payment and delivery are separate statuses, and both are green here.
  const statuses = await page.locator(".status-row .status-text").allTextContents();
  assert(
    statuses.some((status) => /Payment settled/.test(status)),
    `no settlement status: ${statuses.join(" | ")}`,
  );
  assert(
    statuses.some((status) => /fulfilled/.test(status)),
    `no delivery status: ${statuses.join(" | ")}`,
  );

  // The settlement was simulated against the token BEFORE the payload went anywhere.
  const events = await inLab(page, ({ app }) =>
    (app.run?.entries ?? []).map((entry) => `${entry.method} ${entry.url}`),
  );
  const simulatedAt = events.findIndex((event) => event.includes("transferWithAuthorization"));
  const paidAt = events.findLastIndex((event) => event.startsWith("POST"));
  assert(
    simulatedAt >= 0 && simulatedAt < paidAt,
    `the simulation did not run before the payment: ${events.join(" | ")}`,
  );

  assert(/ord_1/.test(await text(page, "#view")), "the reference is missing from the result");
});
