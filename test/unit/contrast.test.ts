// Contrast, computed rather than eyeballed.
//
// Every colour in this tool is declared once in styles.css as `light-dark(light, dark)`. This
// reads that block and checks every pair the page actually renders, in both schemes, against WCAG
// 2.1 AA: 4.5:1 for body text, 3:1 for large text and for the non-text things a person has to be
// able to find (borders, focus rings, the state dots).
//
// It exists because a palette drifts one token at a time. Somebody darkens a surface to make a
// card read better, and the muted text on it quietly drops to 3.9:1, which nobody notices on the
// display they happened to be using. A number in a test notices.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const CSS = readFileSync(join(import.meta.dirname, "../../src/styles.css"), "utf8");

type Scheme = "light" | "dark";
type Pair = readonly [fg: string, bg: string, what: string];

// --- the palette, read from the stylesheet ---------------------------------

function palette(scheme: Scheme): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, light, dark] of CSS.matchAll(
    /--([\w-]+):\s*light-dark\((#[0-9a-f]{3,8}),\s*(#[0-9a-f]{3,8})\)/gi,
  )) {
    const value = scheme === "light" ? light : dark;
    if (name && value) out.set(name, value);
  }
  return out;
}

// --- contrast --------------------------------------------------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  const [r = 0, g = 0, b = 0] = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(fg: string, bg: string): number {
  const lighter = Math.max(luminance(fg), luminance(bg));
  const darker = Math.min(luminance(fg), luminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

// --- what the page actually puts on what -----------------------------------

// Body text and anything a decision rests on: 4.5:1.
const TEXT: readonly Pair[] = [
  ["ink", "bg", "page text"],
  ["ink", "surface", "card text"],
  ["ink", "surface-2", "text on an inset or a hovered row"],
  ["ink", "surface-3", "text on the deepest surface"],
  ["muted", "bg", "helper text on the page"],
  ["muted", "surface", "helper text on a card"],
  ["muted", "surface-2", "helper text on an inset, and every .pick-meta"],
  ["accent", "surface", "a link or an active nav item"],
  ["accent", "accent-soft", "the label of a chosen chip"],
  ["accent-ink", "accent", "the primary button"],
  ["accent-ink", "accent-hover", "the primary button under the pointer"],
  ["accent-ink", "accent-press", "the primary button while pressed"],
  ["bad", "bad-bg", "a danger button under the pointer"],
  ["ink", "surface-3", "a default button while pressed"],
  ["ok", "ok-bg", "a passing check"],
  ["warn", "warn-bg", "a warning callout"],
  ["bad", "bad-bg", "a failing check, and the mainnet badge"],
  ["ok", "surface", "a status word on a card"],
  ["warn", "surface", "a status word on a card"],
  ["bad", "surface", "a status word on a card"],
];

// Large text (>= 18.66px bold or 24px), and non-text that still has to be findable: 3:1.
const LARGE_OR_NON_TEXT: readonly Pair[] = [
  ["faint", "surface", "the faintest label, set at 12px but never load bearing"],
  ["faint", "surface-2", "the same on an inset"],
  ["line-strong", "surface", "an input border, which is how you find the input"],
  ["line-strong", "bg", "a control border against the page"],
  ["accent", "bg", "the focus ring"],
];

for (const scheme of ["light", "dark"] as const) {
  const tokens = palette(scheme);
  const token = (name: string): string => {
    const value = tokens.get(name);
    assert.ok(value, `--${name} is not a light-dark() pair any more`);
    return value;
  };

  test(`${scheme}: the stylesheet still declares one palette`, () => {
    assert.ok(tokens.size >= 18, `only ${tokens.size} tokens parsed: has the palette moved?`);
    for (const name of ["ink", "muted", "faint", "surface", "bg", "accent", "ok", "warn", "bad"]) token(name);
  });

  test(`${scheme}: body text meets WCAG AA (4.5:1)`, () => {
    for (const [fg, bg, what] of TEXT) {
      const value = ratio(token(fg), token(bg));
      assert.ok(value >= 4.5, `${what}: --${fg} on --${bg} is ${value.toFixed(2)}:1, under 4.5`);
    }
  });

  test(`${scheme}: large text and controls meet WCAG AA (3:1)`, () => {
    for (const [fg, bg, what] of LARGE_OR_NON_TEXT) {
      const value = ratio(token(fg), token(bg));
      assert.ok(value >= 3, `${what}: --${fg} on --${bg} is ${value.toFixed(2)}:1, under 3`);
    }
  });
}

// Colour is never the only signal for a state in this page: every check row carries a mark and a
// sentence, which is what WCAG 1.4.1 actually asks for and what somebody who cannot separate red
// from green actually reads. That is a claim about the DOM rather than about the palette, so it is
// asserted where the DOM is: test/e2e/checks.ts.

test("the ratio function agrees with the published worked examples", () => {
  // Black on white is 21:1 exactly, and any colour against itself is 1:1. Without these the
  // assertions above are only checking that a number came out.
  assert.equal(Math.round(ratio("#000000", "#ffffff")), 21);
  assert.equal(Math.round(ratio("#ffffff", "#ffffff")), 1);
  // WCAG's own example: #767676 is the lightest grey that passes on white.
  assert.ok(ratio("#767676", "#ffffff") >= 4.5);
  assert.ok(ratio("#777777", "#ffffff") < 4.54);
});
