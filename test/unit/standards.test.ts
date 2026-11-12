// The rules this tool is written to, asserted rather than documented.
//
// Every one of these started as a sentence in a file header or a README, which is exactly the kind
// of rule that holds until somebody in a hurry does not read it. A convention nothing checks is a
// convention with a half life, so the ones that can be checked mechanically are checked here.
//
// This is deliberately cheap: it reads the source as text and looks for shapes. It cannot prove
// the page is good. It can prove that the specific mistakes this codebase has already talked
// itself out of have not come back.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "../..");

/** Directories that are installed or generated, never written by hand. */
const SKIPPED = new Set(["node_modules", "dist", "screenshots"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED.has(entry) || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** The page: what ships to the browser. */
const SOURCES = walk(join(ROOT, "src")).filter((path) => [".ts", ".html", ".css"].includes(extname(path)));
const SCRIPTS = SOURCES.filter((path) => extname(path) === ".ts");
/** Every hand-written program in the repository: the page, the server, the CLI, the fixture, the build and the tests. */
const PROGRAMS = walk(ROOT).filter((path) => extname(path) === ".ts");

interface SourceFile {
  path: string;
  text: string;
}

const read = (path: string): SourceFile => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") });

function offenders(paths: string[], pattern: RegExp): string[] {
  return paths
    .map(read)
    .filter(({ text }) => pattern.test(text))
    .map(({ path }) => path);
}

test("the page never asks a question through a browser dialog", () => {
  // window.prompt is how the wallet picker started: a numbered list typed as a digit, one
  // off-by-one away from connecting the wrong account, and unstyleable. src/lib/modal.ts replaced
  // it. alert and confirm are the same mistake wearing different hats.
  const found = offenders(SCRIPTS, /\b(?:window\.)?(?:prompt|alert|confirm)\s*\(/);
  assert.deepEqual(found, [], `a browser dialog is being used in: ${found.join(", ")}`);
});

test("nothing is fetched from the network to draw the page", () => {
  // No CDN, no webfont, no analytics. This tool is run by people deciding whether to move money,
  // and the page should work offline and tell nobody when it is open.
  const found = offenders(SOURCES, /(?:src|href)\s*=\s*["']https?:\/\//i);
  assert.deepEqual(found, [], `an external resource is referenced in: ${found.join(", ")}`);
  const fonts = offenders(SOURCES, /@import\s+url\(|fonts\.(?:googleapis|gstatic)\.com/i);
  assert.deepEqual(fonts, [], `a remote font is referenced in: ${fonts.join(", ")}`);
});

test("text from a server reaches the page as text", () => {
  // Everything the page renders from a stranger (an error message, a tool description, a service
  // title) goes in as a text node, through el() and svgEl() in ui.ts. There is no escape hatch: the
  // static markup lives in index.html, and nothing assigns markup as a string.
  const found = offenders(SCRIPTS, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.deepEqual(found, [], `raw HTML is being assigned in: ${found.join(", ")}`);
});

test("colours come from the palette, not from the file that needed one", () => {
  // A hex in a view is a colour that will not follow the theme and that the contrast test cannot
  // see. The palette block in styles.css is the one place they are allowed.
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  const body = css.slice(css.indexOf("* { box-sizing: border-box; }"));
  const strays = [...body.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0]);
  assert.deepEqual(strays, [], `hex colours outside the palette: ${strays.join(", ")}`);

  // netmark.ts is the exception and the only one: a chain's own mark is not themed. Solana is that
  // purple and that green in a dark page and a light one, and putting those in the palette would
  // make them look like tokens this page is free to restyle, which is exactly what they are not.
  const inScripts = offenders(
    SCRIPTS.filter((path) => !path.endsWith("lib/netmark.ts")),
    /["']#[0-9a-f]{6}\b/i,
  );
  assert.deepEqual(inScripts, [], `hex colours hard coded in: ${inScripts.join(", ")}`);

  // And that exception is not a doorway: the marks are drawn, so the only colours in there are the
  // chains' own, and nothing in that file may touch the page's own surfaces or text.
  const marks = readFileSync(join(ROOT, "src/lib/netmark.ts"), "utf8");
  assert.doesNotMatch(marks, /var\(--/, "netmark.ts is reaching into the page palette; it draws logos, not UI");
});

test("motion has one duration, one curve, and an off switch", () => {
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  assert.match(css, /--ease:/, "the shared easing token is gone");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "reduced motion is not honoured");
  assert.match(css, /::view-transition-old\(\*\)/, "reduced motion does not cover view transitions");

  // A transition with its own duration is a thing that moves to its own rhythm.
  const durations = [...css.matchAll(/transition:[^;]*?(\d+m?s)/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(durations)],
    [],
    `a hard coded duration is used instead of --fast or --slow: ${durations.join(", ")}`,
  );
});

test("a button's hover and press never outrank its variant", () => {
  // `button:hover:not(:disabled)` is (0,2,1) and `button.primary` is (0,1,1), so a bare base state
  // rule repaints every variant: the primary button went dark-on-dark under the pointer that way.
  // Base states live in :where(), and variants set --btn-* properties rather than paint.
  const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
  const bare = [...css.matchAll(/^button:(hover|active|focus)[^{]*\{/gm)].map((match) => match[0]);
  assert.deepEqual(bare, [], `a base button state outside :where() overrides every variant: ${bare.join(" ")}`);
  const painting = [...css.matchAll(/^button\.(primary|quiet|danger)[^{]*\{([^}]*)\}/gm)]
    .filter(([, , body = ""]) => /(^|[;\s])(background|color|border-color)\s*:/.test(body))
    .map(([selector]) => (selector.split("{")[0] ?? selector).trim());
  assert.deepEqual(painting, [], `a variant paints directly instead of setting --btn-*: ${painting.join(", ")}`);
});

test("no file has grown past the point where it should have been split", () => {
  // The repo standard is 800 to 1000 lines, for every program here and not only the page: the
  // fixture is the largest file and the one to watch, since it grows a flaw for every check.
  const tooLong = PROGRAMS.map(read)
    .map(({ path, text }): [string, number] => [path, text.split("\n").length])
    .filter(([, lines]) => lines > 1000);
  assert.deepEqual(
    tooLong,
    [],
    `over the line cap: ${tooLong.map(([path, lines]) => `${path} (${lines})`).join(", ")}`,
  );
});

test("the codebase is TypeScript throughout", () => {
  // The page, the server, the CLI, the fixture, the build and the tests. A plain .js or .mjs file
  // beside them is a file the compiler never reads, which is how every other rule here gets
  // quietly skipped.
  const untyped = walk(ROOT)
    .filter((path) => [".js", ".mjs", ".cjs"].includes(extname(path)))
    .map((path) => relative(ROOT, path));
  assert.deepEqual(untyped, [], `untyped program files: ${untyped.join(", ")}`);
});

test("every module imports what it calls, because the compiler checks every module", () => {
  // The kind of mistake a browser only finds when the line runs: a module calls a helper that
  // lives somewhere else and nobody imported it. Splitting the playground into eight files made
  // twelve of these in one go, and each one was a blank screen with a ReferenceError under it.
  //
  // This used to be a text scan over the JavaScript. The TypeScript compiler now refuses an
  // unresolved name outright, so the rule becomes: the compiler is strict, it reads every program
  // in the repository, and `npm run verify` runs it.
  const config = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  for (const option of [
    "strict",
    "noUncheckedIndexedAccess",
    "noUnusedLocals",
    "erasableSyntaxOnly",
    "verbatimModuleSyntax",
  ]) {
    assert.equal(config.compilerOptions[option], true, `tsconfig.json turned ${option} off`);
  }
  const uncovered = PROGRAMS.map((path) => relative(ROOT, path)).filter(
    (path) => !config.include.some((root) => path === root || path.startsWith(`${root}/`)),
  );
  assert.deepEqual(uncovered, [], `the compiler never reads: ${uncovered.join(", ")}`);

  const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
    .scripts;
  assert.match(scripts.typecheck ?? "", /\btsc\b/, "there is no typecheck script");
  assert.match(scripts.verify ?? "", /\btypecheck\b/, "verify does not run the compiler");
});

test("the writing rule holds: no em or en dashes anywhere", () => {
  // Built from code points rather than written out, or this file would be the first thing it
  // catches. Plain punctuation everywhere: a comma, a colon, parentheses, or a spaced hyphen.
  const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
  const text = walk(ROOT).filter((path) =>
    [".ts", ".js", ".mjs", ".css", ".html", ".json", ".md", ".yml", ".yaml"].includes(extname(path)),
  );
  const found = offenders(text, dashes);
  assert.deepEqual(found, [], `a dash that should be plain punctuation in: ${found.join(", ")}`);
});
