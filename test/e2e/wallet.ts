// The wallet picker.
//
// With two extensions installed, `window.ethereum` is whichever one won the race to inject, so the
// page asks. What matters is that asking is a real dialog with a real way out: backing out must
// leave the page unconnected rather than quietly connecting the first wallet in the list, which is
// the failure the numbered `window.prompt` this replaced was one keystroke away from.

import { assert, inLab, walletConnected, withLab } from "./harness.ts";

await withLab(
  "wallet: two wallets are chosen between, and backing out connects neither",
  async ({ page }) => {
    await page.click("#walletButton");
    await page.waitForSelector("dialog.picker");

    const rows = page.locator("dialog.picker .pick");
    assert((await rows.count()) === 2, "the picker did not list both announced wallets");
    assert(/Stub Wallet/.test((await rows.first().textContent()) ?? ""), "the first row is not the first wallet");
    assert(/test.other/.test((await rows.last().textContent()) ?? ""), "the rows do not carry the wallet's rdns");
    assert(
      (await page
        .locator("dialog.picker .pick-icon")
        .first()
        .evaluate((node) => node.tagName)) === "IMG",
      "a data URI icon was not rendered as an image",
    );

    // Escape is a way out, and it is not an answer.
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.picker", { state: "detached" });
    assert(!(await page.evaluate(walletConnected)), "backing out of the picker connected a wallet anyway");
    assert(await inLab(page, ({ app }) => app.wallet === null), "backing out left a wallet on the app state");

    // So is the cancel button.
    await page.click("#walletButton");
    await page.waitForSelector("dialog.picker");
    await page.click("dialog.picker button:has-text('Not now')");
    await page.waitForSelector("dialog.picker", { state: "detached" });
    assert(!(await page.evaluate(walletConnected)), "cancelling the picker connected a wallet anyway");

    // Choosing one connects that one, and says which.
    await page.click("#walletButton");
    await page.waitForSelector("dialog.picker");
    await page.click("dialog.picker .pick:has-text('Other Wallet')");
    await page.waitForFunction(walletConnected);
    assert(
      /Other Wallet/.test((await page.getAttribute("#walletButton", "title")) ?? ""),
      "the button does not name the wallet that was chosen",
    );
  },
  { secondWallet: true },
);

await withLab("wallet: one wallet connects without asking", async ({ page }) => {
  await page.click("#walletButton");
  await page.waitForFunction(walletConnected);
  assert((await page.locator("dialog.picker").count()) === 0, "a single wallet still opened the picker");
});
