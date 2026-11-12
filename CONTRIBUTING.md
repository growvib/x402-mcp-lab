# Contributing

Thanks for helping improve the x402 lab. It is a workbench for the x402 payment protocol and the
MCP servers that speak it, and the bar for a change is set by what it is for: somebody uses this
page to decide whether money moved correctly, so it must never be the thing that is wrong.

## Reporting problems

- **A bug in the lab** (a check that passes something it should fail, a page that misreads a
  quote, a crash): open an issue with the bug report template. A failing `npm run check` report,
  redacted, is the most useful thing you can attach.
- **A server that fails a check**: that is the lab working. Take it to the server's maintainers,
  unless you think the check itself is wrong, in which case open an issue and cite the spec.
- **A security issue**: follow [SECURITY.md](SECURITY.md). Never in a public issue.

## Setting up

Node 22.18 or newer (`.node-version` pins the major). Node runs the TypeScript sources directly,
so there is no compile step outside the page bundle.

```bash
npm ci
npx playwright install chromium   # once, for the browser specs
npm run dev                       # rebuilds the page on change and serves it on :4402
npm run mock                      # the demo server the lab opens on, in a second terminal
```

## Making a change

1. Fork the repository and create a branch.
2. Make the change, with a test. Logic with a branch, a parser or a money decision gets a unit test
   in `test/unit/`; a change in what the page shows or allows gets a browser spec in `test/e2e/`.
   A new conformance check is watched going red: teach `fixtures/mock-x402.ts` to break in the way
   the check detects, and assert in `test/unit/conformance.test.ts` that exactly that check fails.
3. Run the whole gate. It is what CI runs, and a red gate is a blocked merge:

   ```bash
   npm run verify   # typecheck, lint, unit tests, build, browser specs
   ```

   `npm run format` fixes what Biome reports as formatting.
4. Add a line to [CHANGELOG.md](CHANGELOG.md) under "Unreleased" when the change is visible to
   somebody using the lab.
5. Open a pull request. Every change to `main` goes through a reviewed pull request and is
   squash-merged.

## Conventions

The ones a test enforces are in `test/unit/standards.test.ts` and `test/unit/contrast.test.ts`; the
README's last section explains why each exists. Beyond those:

- **Strict TypeScript, no `any`.** Anything that arrives from the network is `unknown` until
  `src/lib/json.ts` has read it. Prefer a type guard to a cast.
- **No runtime dependencies.** The page draws everything it shows from code in this repository and
  fetches nothing to draw itself. A development tool is fine; a library the page ships is not.
- **Pure where it can be.** `src/lib/` takes its transport as an argument, so the page, the
  headless runner and the tests give the same answers.
- **Comments say why.** The code says what. A comment that explains a decision, or the incident
  that made it necessary, is worth keeping; one that narrates the next line is not.
- **Plain punctuation.** No em or en dashes, in code, copy or commit messages.

## Rules

- No secrets, keys, tokens, wallet addresses of your own, or personal data in any file, fixture or
  screenshot. The lab's export redacts credentials; check anything you paste anyway.
- A preset in `presets/` holds only what the source publishes about itself.
- By contributing you agree your work is released under the [MIT License](LICENSE) and that you
  follow the [Code of Conduct](CODE_OF_CONDUCT.md).
