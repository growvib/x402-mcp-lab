// The page loads, every view renders, and nothing throws on the way.
import { assert, text, withLab } from "./harness.ts";

await withLab("smoke: every view renders", async ({ page }) => {
  assert((await text(page, "#envBadge")).includes("Simulation"), "the lab did not open on the demo source");

  for (const route of ["playground", "learn", "checks", "orders", "history"]) {
    await page.click(`.nav[data-route="${route}"]`);
    await page.waitForTimeout(150);
    assert((await text(page, "#view")).trim().length > 0, `${route} rendered nothing`);
  }

  // The source drawer holds the endpoint settings, and the rail holds navigation only.
  await page.click('.nav[data-route="playground"]');
  await page.click("#sourceButton");
  await page.waitForSelector("#sourceResource");
  assert((await page.locator(".rail input").count()) === 0, "settings leaked back into the navigation rail");
  assert(
    (await text(page, "#sourceBody")).includes("What this lab may reach"),
    "the drawer does not say what the proxy allows",
  );
});
