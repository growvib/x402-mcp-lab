// x402 over MCP: the requirements arrive in a tool result, and the same review pays them.

import { assert, connectWallet, PAY_TO, text, typedSignatures, waitInLab, withLab } from "./harness.ts";

await withLab("mcp: call unpaid, review the requirements, sign, call again", async ({ page }) => {
  await connectWallet(page);

  await page.click(".tab:has-text('MCP tool call')");
  await page.click("button:has-text('Connect')");
  const paidTool = ".option:has(.option-title:text-is('create_paid_order'))";
  await page.waitForSelector(paidTool);

  // A tool that spends says so in the list, before it is called.
  const paid = await text(page, paidTool);
  assert(/costs money/.test(paid), `the spending tool is not marked: ${paid}`);

  await page.click(paidTool);
  await page.fill("input[name='item']", "sample-report");
  await page.fill("input[name='quantity']", "1");
  await page.click("button:has-text('Call the tool')");
  await page.waitForSelector("text=Your payment quote");

  await page.fill("#guardPayTo", PAY_TO);
  await waitInLab(page, ({ app }) => app.guards.expectedPayTo.length === 42);

  // The requirements from a tool result go through the same checks as the HTTP ones.
  assert(/All \d+ payment checks passed/.test(await text(page, ".check-strip")), "the tool result failed a check");

  await page.locator("#paySettleButton").click();
  await page.waitForSelector("text=ord_mcp_1");

  const signed = await typedSignatures(page);
  assert(signed === 1, `the wallet signed ${signed} times for one payment`);
});
