// The rails, watched holding.
//
// Three different refusals, because they fail for three different reasons: a check that says the
// quote is wrong, a simulation that says the token would refuse it, and a gate that says no
// payment should happen right now whatever the quote says.

import type { Page } from "playwright";

import { assert, connectWallet, inLab, PAY_TO, text, typedSignatures, waitInLab, withLab } from "./harness.ts";

async function quote(page: Page, { pin }: { pin?: string } = {}): Promise<void> {
  await connectWallet(page);
  await page.click(".pick:has-text('Sample report')");
  await page.waitForSelector(".pick:has-text('Standard')");
  await page.click(".pick:has-text('Standard')");
  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=Your payment quote");
  if (pin) {
    await page.fill("#guardPayTo", pin);
    await waitInLab(page, ({ app }, want) => app.guards.expectedPayTo === want, pin);
  }
}

await withLab("blocks: a recipient you did not pin never reaches the wallet", async ({ page }) => {
  // One character off the quoted address, which is the realistic mistake.
  await quote(page, { pin: "0x2222222222222222222222222222222222222223" });

  const payButton = page.locator("#paySettleButton");
  assert(((await payButton.textContent()) ?? "").includes("Blocked"), "the pay button does not read as blocked");
  assert(await payButton.isDisabled(), "the pay button is still clickable with a failed check");

  // Failures expand themselves, with the reason and what to do about it.
  const failed = await text(page, ".check-row.failed");
  assert(/Do not pay/.test(failed), `the failed check suggests no action: ${failed}`);

  // Force the click past the disabled attribute: the guard lives in the handler, not the markup.
  await payButton.dispatchEvent("click");
  await page.waitForSelector("text=Your wallet was not opened");

  assert(
    (await typedSignatures(page)) === 0,
    "the wallet was asked to sign a payment to an address the payer did not pin",
  );
});

await withLab(
  "blocks: a settlement the token would refuse is never sent",
  async ({ page }) => {
    await quote(page, { pin: PAY_TO });
    await page.locator("#paySettleButton").click();
    await page.waitForSelector("text=Not sent");

    assert(
      (await typedSignatures(page)) === 1,
      "the signature should have been taken: the simulation needs one to run",
    );
    const sent = await inLab(
      page,
      ({ app }) => (app.run?.entries ?? []).filter((entry) => /Payment sent/.test(entry.note ?? "")).length,
    );
    assert(sent === 0, "the payload was sent although the settlement would revert");
  },
  { simulationReverts: true },
);

await withLab("blocks: a second payment cannot follow the first straight away", async ({ page }) => {
  await quote(page, { pin: PAY_TO });
  await page.locator("#paySettleButton").click();
  await page.waitForSelector("text=Paid and delivered");

  // Straight back for another one. Nothing legitimate pays twice within the cooldown, so the gate
  // refuses before the wallet is opened: this is what stops a stuck loop draining a wallet.
  // The choice is remembered, so buying the same thing again is two clicks.
  await page.click("button:has-text('Start another')");
  await page.click("button:has-text('Continue')");
  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=Your payment quote");
  const signedBefore = await typedSignatures(page);

  await page.locator("#paySettleButton").click();
  await page.waitForSelector("text=The lab waits");

  assert((await typedSignatures(page)) === signedBefore, "the wallet was opened for a payment the gate refused");
});
