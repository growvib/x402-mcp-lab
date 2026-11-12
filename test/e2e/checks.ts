// The server checks, run from the page, with the skips still visible as skips.

import { assert, inLab, text, waitInLab, withLab } from "./harness.ts";

await withLab("checks: a healthy demo server is green and the money checks stay skipped", async ({ page }) => {
  await page.click('.nav[data-route="checks"]');
  await page.click("button:has-text('Run the checks')");
  await waitInLab(page, ({ checks }) => checks?.report || checks?.error, null, { timeout: 30000 });

  const error = await inLab(page, ({ checks }) => checks?.error);
  assert(!error, `the suite threw: ${error}`);

  const counts = await inLab(page, ({ checks }) => checks?.report?.counts);
  assert(counts, "the suite produced no report");
  assert(counts.fail === 0, `${counts.fail} checks failed against a conformant server`);
  assert(counts.skip >= 2, "the money checks are not being reported as skipped");
  assert(counts.pass >= 20, `only ${counts.pass} checks passed`);

  const view = await text(page, "#view");
  assert(/needs a funded wallet/.test(view), "the skipped money checks do not say what they needed");
  assert(/Nothing here spends/.test(view), "the page does not say that running the checks is free");

  // WCAG 1.4.1: a state is never carried by colour alone. Somebody who cannot separate red from
  // green has to be able to read this report, and a green dot is not a sentence. Every row carries
  // a mark, and the summary counts are words.
  const unmarked = await page.evaluate(
    () =>
      [...document.querySelectorAll(".check-row")].filter(
        (row) => !(row.querySelector(".check-mark")?.textContent ?? "").trim(),
      ).length,
  );
  assert(unmarked === 0, `${unmarked} check rows carry their state in colour alone`);
  assert(/passed/.test(view) && /skipped/.test(view), "the counts are not spelled out in words");
});
