// Every screen and state worth looking at, captured as PNGs for design review.
//
//   npm run build && node test/e2e/screenshots.ts [outDir]
//
// It drives the same demo server and the same stub wallet the specs use, so what is captured is
// the real page in a real state. States that only exist when something is wrong are produced by
// breaking the demo server on purpose, which is the only honest way to photograph them.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Browser, Page } from "playwright";

import {
  connectWallet,
  DEFAULT_WALLET,
  installStubWallet,
  LAB_PORT,
  launchBrowser,
  PAY_TO,
  type StubWalletOptions,
  startFixture,
  startLab,
  waitInLab,
} from "./harness.ts";

const OUT = process.argv[2] ?? join(process.cwd(), "screenshots");
mkdirSync(OUT, { recursive: true });

let count = 0;

// The app is a fixed-height shell with its own scrolling column, so a full-page screenshot would
// only ever show one viewport of it. For review, the shell is briefly allowed to grow to its
// content, captured, and put back: the layout is unchanged, the whole screen is in the frame.
const UNFOLD = `
  .app { height: auto !important; }
  .view { overflow: visible !important; }
  .rail { position: sticky; top: 0; align-self: start; }
`;

async function capture(page: Page, name: string, { fullPage = true, unfold = true } = {}): Promise<void> {
  const style = unfold ? await page.addStyleTag({ content: UNFOLD }) : null;
  if (style) await page.waitForTimeout(120);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  if (style) await style.evaluate((node) => (node as Element).remove());
  count += 1;
  console.log(`  ${name}.png`);
}

interface OpenLab {
  page: Page;
  close(): Promise<void>;
}

async function openLab(
  browser: Browser,
  {
    flaws = "",
    walletOptions = {},
    theme = "dark",
  }: { flaws?: string; walletOptions?: Partial<StubWalletOptions>; theme?: "dark" | "light" } = {},
): Promise<OpenLab> {
  const fixture = await startFixture({ X402_FIXTURE_FLAWS: flaws });
  const lab = await startLab("fixture,growvib");
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 940 });
  await page.addInitScript(installStubWallet, { ...DEFAULT_WALLET, ...walletOptions });
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("x402-lab:theme", value);
    } catch {
      // A private window: the default theme is fine.
    }
  }, theme);
  await page.goto(`http://localhost:${LAB_PORT}/`);
  await page.waitForSelector("#envBadge:not([hidden])");
  return {
    page,
    close: async () => {
      await page.close();
      lab.kill();
      fixture.kill();
    },
  };
}

async function pin(page: Page, address: string): Promise<void> {
  await page.fill("#guardPayTo", address);
  await waitInLab(page, ({ app }, want) => app.guards.expectedPayTo === want, address);
}

async function toReview(page: Page, { variant = "Priority" } = {}): Promise<void> {
  await page.click(".pick:has-text('Sample report')");
  await page.waitForSelector(`.pick:has-text('${variant}')`);
  await page.click(`.pick:has-text('${variant}')`);
  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=Your payment quote");
}

const browser = await launchBrowser();

// The happy path, as somebody meets it -------------------------------------
{
  const lab = await openLab(browser);
  const { page } = lab;

  await page.waitForSelector(".pick");
  await capture(page, "01-choose-what");

  // The same step with the catalog narrowed, which is what it looks like against a real one.
  await page.click(".chip:has-text('Media')");
  await page.waitForFunction(() => /of 10/.test(document.querySelector(".count-line")?.textContent ?? ""));
  await capture(page, "01b-choose-filtered");
  await page.fill("#catalogSearch", "render");
  await page.waitForFunction(() => /"render"/.test(document.querySelector(".count-line")?.textContent ?? ""));
  await capture(page, "01c-choose-searched");
  await page.click(".count-line button:has-text('Clear')");
  await page.waitForFunction(() => /of 40/.test(document.querySelector(".count-line")?.textContent ?? ""));

  // A service with more setups than anyone wants to read: the step opens on the three the endpoint
  // recommends, with the other twenty seven one click away.
  await page.click(".pick:has-text('Bulk export')");
  await page.waitForSelector(".pick.tall");
  await capture(page, "01e-express-setups");
  await page.click("button:has-text('Show all 30')");
  await page.waitForFunction(() => document.querySelectorAll(".pick").length > 25);
  await capture(page, "01f-all-setups");
  await page.click("button:has-text('Back to the catalog')");
  await page.waitForSelector(".pick-list");

  // The playground with nothing in it yet: the handshake, where the empty space was.
  await page.click("button:has-text('Skip and write the request')");
  await page.waitForSelector(".card.teach");
  await capture(page, "01d-empty-playground");
  await page.click("button:has-text('Open the catalog')");
  await page.waitForSelector(".pick");

  await connectWallet(page);
  await page.click(".pick:has-text('Sample report')");
  await page.waitForSelector(".pick:has-text('Priority')");
  await capture(page, "02-choose-variant");

  await page.click(".pick:has-text('Priority')");
  await page.waitForSelector("button:has-text('Get payment quote')");
  await capture(page, "03-request");

  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=Your payment quote");
  await pin(page, PAY_TO);
  await capture(page, "04-review");

  await page.click("button:has-text('View checks')");
  await page.waitForTimeout(150);
  await capture(page, "05-review-checks-open");

  await page.locator("#paySettleButton").click();
  await page.waitForSelector("text=Paid and delivered");
  await capture(page, "06-result");

  await page.click('.nav[data-route="history"]');
  await page.waitForTimeout(250);
  await capture(page, "07-history");

  await page.click('.nav[data-route="learn"]');
  await page.waitForTimeout(200);
  await capture(page, "08-learn");

  await page.click("#sourceButton");
  await page.waitForSelector("#sourceResource");
  await capture(page, "09-source-drawer", { fullPage: false, unfold: false });
  await page.keyboard.press("Escape");

  await lab.close();
}

// MCP ----------------------------------------------------------------------
{
  const lab = await openLab(browser);
  const { page } = lab;
  await connectWallet(page);
  await page.click(".tab:has-text('MCP tool call')");
  await page.click("button:has-text('Connect')");
  await page.waitForSelector(".option:has(.option-title:text-is('create_paid_order'))");
  await capture(page, "10-mcp-tools");

  await page.click(".option:has(.option-title:text-is('create_paid_order'))");
  await page.fill("input[name='item']", "sample-report");
  await page.fill("input[name='quantity']", "1");
  await page.click("button:has-text('Call the tool')");
  await page.waitForSelector("text=Your payment quote");
  await pin(page, PAY_TO);
  await capture(page, "11-mcp-review");
  await lab.close();
}

// Refusals -----------------------------------------------------------------
{
  const lab = await openLab(browser);
  const { page } = lab;
  await connectWallet(page);
  await toReview(page, { variant: "Standard" });
  await pin(page, "0x2222222222222222222222222222222222222223");
  await capture(page, "12-blocked-wrong-recipient");

  await page.locator("#paySettleButton").dispatchEvent("click");
  await page.waitForSelector("text=Your wallet was not opened");
  await capture(page, "13-blocked-forced");
  await lab.close();
}

{
  const lab = await openLab(browser);
  const { page } = lab;
  await connectWallet(page);
  await toReview(page, { variant: "Standard" });
  await pin(page, PAY_TO);
  await page.locator("#paySettleButton").click();
  await page.waitForSelector("text=Paid and delivered");
  await page.click("button:has-text('Start another')");
  await page.click("button:has-text('Continue')");
  await page.click("button:has-text('Get payment quote')");
  await page.waitForSelector("text=Your payment quote");
  await page.locator("#paySettleButton").click();
  await page.waitForSelector("text=The lab waits");
  await capture(page, "14-gate-cooldown");
  await lab.close();
}

// The review card on a live source. There is no second "this is real money" step: the card already
// states the amount, the network and the recipient, and the badge says mainnet. The demo server is
// relabelled so the state can be photographed without a live endpoint or a real payment.
{
  const lab = await openLab(browser);
  const { page } = lab;
  await connectWallet(page);
  await toReview(page, { variant: "Standard" });
  await pin(page, PAY_TO);
  await page.evaluate(() => {
    const target = window.x402lab?.target;
    if (target) {
      target.environment = "mainnet";
      target.name = "Production";
    }
    const badge = document.getElementById("envBadge");
    if (badge) {
      badge.className = "pill bad";
      badge.textContent = "Mainnet";
    }
  });
  await page.waitForSelector("#envBadge:has-text('Mainnet')");
  await capture(page, "15-mainnet-review");
  await lab.close();
}

// Server checks ------------------------------------------------------------
{
  const lab = await openLab(browser);
  const { page } = lab;
  await page.click('.nav[data-route="checks"]');
  await page.waitForTimeout(200);
  await capture(page, "16-checks-before");
  await page.click("button:has-text('Run the checks')");
  await waitInLab(page, ({ checks }) => checks?.report, null, { timeout: 30000 });
  await page.waitForTimeout(250);
  await capture(page, "17-checks-green");
  await lab.close();
}

{
  const lab = await openLab(browser, {
    flaws: "head-405,no-expose,no-descriptions,mcp-dangling,mcp-unmarked,resource-relative",
  });
  const { page } = lab;
  await page.click('.nav[data-route="checks"]');
  await page.click("button:has-text('Run the checks')");
  await waitInLab(page, ({ checks }) => checks?.report, null, { timeout: 30000 });
  await page.waitForTimeout(250);
  await capture(page, "18-checks-failing");
  await lab.close();
}

// The two modes, and the two themes ----------------------------------------
{
  const lab = await openLab(browser);
  const { page } = lab;
  await connectWallet(page);
  await toReview(page);
  await pin(page, PAY_TO);
  await page.click("button:has-text('Advanced')");
  await page.waitForTimeout(200);
  await capture(page, "19-advanced-mode");
  await lab.close();
}

{
  const lab = await openLab(browser, { theme: "light" });
  const { page } = lab;
  await connectWallet(page);
  await toReview(page);
  await pin(page, PAY_TO);
  await capture(page, "20-light-theme");
  await lab.close();
}

// Signing in, and the order that needs no signature afterwards.
{
  const lab = await openLab(browser);
  const { page } = lab;
  // Connecting is the sign-in: the balance is in the top bar before anybody goes looking for it.
  await connectWallet(page);
  await waitInLab(page, ({ app }) => app.agentToken !== null);
  await capture(page, "22-signed-in", { fullPage: false, unfold: false });

  await toReview(page, { variant: "Standard" });
  await pin(page, PAY_TO);
  await capture(page, "23-balance-offered");
  await page.click("button:has-text('from balance')");
  await page.waitForSelector("text=Delivered, paid from your balance");
  await capture(page, "24-balance-result");
  await lab.close();
}

// The wallet picker, which only exists when more than one wallet is installed.
{
  const lab = await openLab(browser, { walletOptions: { secondWallet: true } });
  const { page } = lab;
  await page.click("#walletButton");
  await page.waitForSelector("dialog.picker");
  await page.waitForTimeout(250);
  await capture(page, "21-wallet-picker", { fullPage: false, unfold: false });
  await lab.close();
}

await browser.close();
console.log(`${count} screenshots in ${OUT}`);
