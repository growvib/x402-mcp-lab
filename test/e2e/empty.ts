// The playground before anything has happened in it.
//
// A source with no catalog, no wallet and no quote opens on a form and a button, which says nothing
// about what the button starts. What fills that space has to be true (a quote costs nothing, the
// wallet is not needed yet), has to leave once there is a real subject on the screen, and has to be
// dismissible for good.

import { assert, text, withLab } from "./harness.ts";

await withLab("empty: the first screen teaches the handshake, then gets out of the way", async ({ page }) => {
  await page.waitForSelector(".pick");
  await page.click("button:has-text('Skip and write the request')");

  await page.waitForSelector(".card.teach");
  const teach = await text(page, ".card.teach");
  for (const beat of ["Ask", "Price", "Sign", "Settle"]) {
    assert(teach.includes(beat), `the handshake is missing the ${beat} beat`);
  }
  assert(/No wallet needed yet/.test(teach), "the empty state did not say a quote needs no wallet");
  assert(/free to press/.test(teach), "the empty state did not say the demo source cannot spend");

  // It is scaffolding, so it can be taken down, and it stays down.
  await page.click(".card.teach button:has-text('Hide this')");
  assert((await page.locator(".card.teach").count()) === 0, "the handshake did not hide");
  await page.reload();
  await page.waitForSelector("#envBadge:not([hidden])");
  await page.waitForSelector(".pick");
  await page.click("button:has-text('Skip and write the request')");
  await page.waitForSelector("button:has-text('Get payment quote')");
  assert((await page.locator(".card.teach").count()) === 0, "the handshake came back after being dismissed");

  // And once there is a quote on the screen, the screen is about the quote.
  await page.evaluate(() => localStorage.removeItem("x402-lab:handshake"));
  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=Your payment quote");
  assert((await page.locator(".card.teach").count()) === 0, "the handshake survived into the review step");
});
