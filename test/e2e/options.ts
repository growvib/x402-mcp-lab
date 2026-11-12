// The option step, against a service with more options than anyone wants to read.
//
// The demo server's bulk export carries 30 options across three qualities and ten regions, and
// recommends three of them. The step opens on those three. The rest are reachable, because this is
// a lab and reproducing a bug means reaching the exact option that caused it, but they are asked
// for rather than scrolled past.

import { assert, inLab, withLab } from "./harness.ts";

const countLine = (): string => document.querySelector(".count-line")?.textContent ?? "";

await withLab("options: a long list opens on what the endpoint recommends", async ({ page }) => {
  await page.waitForSelector(".pick");
  await page.click(".pick:has-text('Bulk export')");
  await page.waitForSelector(".pick.tall");

  // Three setups, not thirty, and the line says so rather than implying there are only three.
  assert((await page.locator(".pick.tall").count()) === 3, "the step did not open on the recommended setups");
  const line = await page.evaluate(countLine);
  assert(/3 of 30 setups/.test(line), `the count line read: ${line}`);

  // The rest are one click away.
  await page.click("button:has-text('Show all 30')");
  await page.waitForFunction(() => document.querySelectorAll(".pick").length > 25);
  assert(
    /All 30, read in one request/.test(await page.evaluate(countLine)),
    "the expanded list did not say what it holds",
  );

  // Filtering here is over the whole list, because the whole list is in hand.
  await page.fill("#optionFilter", "usa");
  await page.waitForFunction(
    () =>
      /of 30/.test(document.querySelector(".count-line")?.textContent ?? "") &&
      document.querySelectorAll(".pick").length < 10,
  );
  const filtered = await page.evaluate(countLine);
  assert(/3 of 30/.test(filtered), `the filtered count read: ${filtered}`);

  await page.fill("#optionFilter", "nothing like this");
  await page.waitForSelector("text=Nothing here matches that.");

  // And it collapses back to the recommendation.
  await page.fill("#optionFilter", "");
  await page.waitForFunction(() => document.querySelectorAll(".pick").length > 25);
  await page.click("button:has-text('Show the recommended ones')");
  await page.waitForFunction(() => document.querySelectorAll(".pick.tall").length === 3);

  // Choosing a recommended setup fills the request with that option, not with the first of thirty.
  await page.click(".pick.tall:has-text('Best value')");
  const body = await inLab(page, ({ pg }) => pg.body);
  assert(
    body?.item === "bulk-export" && body.variant === "bulk-global",
    `the choice did not fill the request: ${JSON.stringify(body)}`,
  );
  assert(Number(body.quantity) >= 10, `the option's minimum did not reach the request: ${JSON.stringify(body)}`);
});

await withLab("options: a short list is not hidden behind a disclosure", async ({ page }) => {
  await page.waitForSelector(".pick");
  await page.click(".pick:has-text('Sample report')");
  await page.waitForSelector(".pick:has-text('Priority')");
  assert((await page.locator("button:has-text('Show all')").count()) === 0, "two options were put behind a disclosure");
  assert((await page.locator("#optionFilter").count()) === 0, "two options were given a filter box");
});
