# x402 lab

A workbench for the x402 payment protocol and for MCP servers that speak it: choose what to buy,
read what you are about to sign, sign it with a browser wallet, and see exactly what happened.

It works against **any** x402 resource. The request form builds itself from the resource's own
Bazaar declaration, and where a resource publishes a catalog the lab opens on that instead of
asking you to paste an identifier. GrowVib ships as a preset because that is where this tool grew
up.

```bash
npm install
npm start                # builds the page and serves it on http://localhost:4402
npm run mock             # the demo server on 127.0.0.1:4999 (a target, not a page)
npm run check -- https://api.example.com/v1/agent/orders
```

Node 22.18 or newer. Node runs TypeScript as it stands, so the server, the headless runner and the
tests execute from source with no compile step; only the page is bundled, by esbuild. There are no
runtime dependencies, on purpose: a tool for deciding whether money moved correctly should not
itself pull in a dependency tree. Everything `npm install` fetches is a development tool
(TypeScript, esbuild, Biome, Playwright).

**It opens in simulation.** The first source is the bundled demo server, which has no chain and no
wallet behind it, so every button is free to press while you learn what they do. Reaching anything
that can cost money is a deliberate switch in the Source drawer.

## Why the browser

The payment step needs a signature, a signature needs a private key, and a key in a `.env` file is
a key you will forget about. Here the key stays in MetaMask, Rabby, or anything that announces
itself over EIP-6963, and this process never sees it: an EIP-3009 authorization is an EIP-712
typed-data signature, which every browser wallet can produce.

## Playground

One flow, two transports. HTTP and MCP differ in how the payment requirements travel (a 402 header,
or a field in a tool result) and in nothing else that matters to the person paying, so they share
the steps, the checks, the signer and the outcome.

**Choose → Request → Review payment → Result.** A finished step collapses to one line you can
reopen, so the screen is always about the decision in front of you.

- **Choose** reads the catalog the endpoint publishes, with its variants and their prices. Your
  choice fills the request under the field names the preset declares, so nothing here knows what a
  GrowVib service is. A source with no catalog starts at Request. Each option row also states what the
  option says about how it is ordered, read off its own metadata: the start window it lists, the kind
  of link it takes (a post, a profile, a channel), and whether it is a per-post subscription, in which
  case choosing it puts a `posts` count in the request and the quantity becomes the amount per post.
  Those three facts are the ones an agent driving this endpoint for a week got wrong when nothing
  showed them.
- **Request** builds its fields from the resource's own schema. "Edit as JSON" is always there for
  what a form cannot express. Before the first quote it also says what the button starts: the four
  beats of the handshake, that asking costs nothing, and that the wallet is not needed until the
  signature. It is dismissible, and the dismissal sticks.
- **Review payment** is the point of the tool. It states the amount, the network, the recipient and
  your own limits in plain words, and gates the button on ten checks.
- **Result** reports payment and delivery as **separate statuses**, because the case where they
  disagree is the one worth knowing by heart: money moved, nothing was created, the funds are a
  balance on that endpoint, and paying again buys nothing. Where the source publishes an order read
  (the preset's `orders.get`), Result also reads the order back once on arrival and again on
  **Refresh status**: the status now, what it was **placed as** (service and option), how much has
  arrived, and the charge. When the option the endpoint placed differs from the one you chose, it
  says so in red. That check exists because a paid "High Quality" GrowVib order was placed as
  "Standard" and this screen called it a success (the server bug is fixed; the check stays).
  Where the order read carries a `delivery` block, Result and Orders show it as the endpoint states
  it: started or not, waiting for the target's next post on a subscription, start overdue against the
  listed window, never an estimate of completion, because the endpoint makes none.

### Orders

The **Orders** page lists what the wallet behind the current agent token bought, newest first, a
page at a time from the endpoint (`orders.list`), with the endpoint's own total. A row opens in
place to the same facts the result step shows and a **Refresh this order**; **Refresh** at the top
re-reads the page. Every read is a GET with the token in the `Authorization` header and nothing
that could pay. With no token yet the page offers the wallet sign-in instead of an empty list. The
token belongs to one wallet's account, so orders paid from a Solana wallet and orders from an EVM
sign-in are two different lists. The demo server serves both reads and moves an order one status
per read, so a refresh is visibly a re-read (`test/e2e/orders.ts`).

### The catalog step

GrowVib's catalog runs to hundreds of services across dozens of platforms (the endpoint states the
current counts). That is the size at which the difference between filtering a page and asking an
endpoint stops being academic, so **the search, the filters
and the paging all go to the endpoint** and the count line reports what came back: _Showing 13-24 of
50 · Instagram · "story"_. A client that filters the rows it already holds says "12 results" and
means "12 of the 12 rows in my memory", which is how somebody concludes a catalog of four hundred
has nothing in it.

The filter chips are the endpoint's own vocabulary, with the endpoint's own counts: a preset names
each dimension, where its values are published, and which one depends on another (GrowVib's metric
list needs a platform first, so that row appears when there is a platform to list for). A value
nobody chose is never invented, and a total the endpoint did not give is reported as absent rather
than replaced by the number of rows on screen.

### The setups, not all ninety of them

One real service carries 92 options: three qualities crossed with every country and gender the
provider targets. The seller already computes the two or three untargeted setups it recommends and
keeps them current, so the step opens on those, with a line saying what it is showing (_3 of 30
setups, the ones this endpoint recommends_) and the rest one click away behind _Show all_. This is a
lab, so reproducing a bug means being able to reach the exact option that caused it; it just should
not be the first thing anyone reads.

Where they come from is configuration like everything else: a preset says where the recommended
setups live (`metadata.express_presets` for GrowVib) and which field joins them to an option. A
source that declares none shows its options plainly, and a service with six or fewer is never put
behind a disclosure.

The filter over the full list is the one place this tool filters locally rather than at the
endpoint, because one request really does return every option a service has. The count line says
so: _All 30, read in one request_.

A catalog price is labelled as what it is. GrowVib quotes a rate per thousand, and a bare `$9.71`
beside a service whose minimum is ten units reads as the total and is out by two orders of
magnitude, so the preset declares the unit and the row says `from $9.71 per 1K`. The amount that
matters is the quote, two steps later, and that one is exact.

**Guided** shows one decision at a time with a sentence on what just happened. **Advanced** expands
the checks, the signed authorization, the payloads and the request inspector. Same flow underneath.

### Paying on Solana

A quote can offer more than one network, and GrowVib's offers two: USDC on Base and USDC on
Solana. The switcher is the network button in the top bar, by name rather than by CAIP-2 id, because a
Solana cluster is identified by thirty-two characters of its genesis hash and that is not something
to put on a button.

The two rails are not the same payment wearing different labels. On Base the wallet signs an
authorization (EIP-3009) and the facilitator makes the transfer. On Solana the wallet signs the
**transfer itself**, in a transaction whose fee payer is the facilitator, so the payer needs no SOL
and the facilitator can submit it. Everything needed to build that arrives in the 402, in the
requirement's `extra`: the fee payer and a recent blockhash. Nothing is fetched from a chain, so
the promise that this page fetches nothing to do its work survives.

Three pieces of Solana are implemented here because a transaction cannot be built without them
(`src/lib/base58.ts` and `src/lib/solana.ts`): base58, the associated-token-account derivation, and
the legacy message wire format. The account derivation needs SHA-256 and an ed25519 curve check,
because a derived address is defined by being a value no private key can sign for, and finding one
means hashing until the answer falls off the curve.

None of that is code to trust on its own reading, so it is checked against things outside it:

- **The derivation against the chain.** `test/unit/solana.test.ts` pins the token account for a
  real mainnet owner and mint, the one `getTokenAccountsByOwner` returns. A derivation wrong in any
  part lands somewhere else.
  page's own code and the Go test beside it reads it back with the parser the server actually uses,
  asserting the fee payer, the paying wallet, the blockhash, both token accounts, the mint, the
  authority, the amount, the decimals byte, the instruction layout the facilitator verifies, and
  that the fee payer appears in no instruction. It found a real bug on the first run: base58 of an
  all-zero value (the System Program id, which is thirty-two ones) produced 33 bytes, which shifts
  every byte after it in a serialized message.

**The transaction has exactly the layout the facilitator verifies** (x402 `exact` on SVM): set
compute unit limit (20,000), set compute unit price (1 micro-lamport), `TransferChecked`, and a
memo, in that order and nothing else. The memo is the quote's `extra.memo` when it names one, and a
random 16-byte hex nonce otherwise, so two payments with the same parameters are two different
transactions. The facilitator's fee payer is account zero and appears in no instruction: an account
it signs for that an instruction also names is an account a client could spend, and the scheme
refuses it. The first version put an idempotent create of the recipient's token account in front
of the transfer, funded by the fee payer, with no compute budget and no memo, and PayAI refused
every Solana payment at verify for it. The recipient's token account therefore has to exist before
anyone pays; GrowVib's does (created on 2026-09-30).

**A mint whose unit this page cannot establish is refused, not guessed at.** Decimals live in the
mint account, this rail has no RPC by design, and the endpoint is the one choosing the mint. The
amount in a quote is atomic, so the same `900000` is ninety cents of USDC or nine hundred thousand
whole tokens of a mint with no decimals, and the second one walks under a one dollar ceiling while
the page prints "0.90". So the unit comes from this tool's table of known mints (USDC, USDT) or
from a `decimals` the endpoint publishes beside the quote, and when neither answers the decimals
check fails and nothing can be signed. Every payment carries `TransferChecked`'s decimals byte, so
the token program enforces the unit as well; there is no unchecked-`Transfer` path to fall back to.
The first version of this had that fallback and a hardcoded six behind the spend ceiling, which is
the kind of thing a review catches and a demo does not.

Wallets speak through the **Wallet Standard**, which is how Phantom, Solflare and Backpack all
register: the wallet announces itself with an event and exposes named features, and the one this
needs is `solana:signTransaction`, which takes raw transaction bytes and returns them signed. Bytes
are what this tool has, so nothing here needs `@solana/web3.js`. (The first version called an old
`request({ method: "signTransaction" })` deep-link API instead. Phantom answers that with "Not
implemented", which is what a live quote showed. The injected path survives as a fallback for a
wallet that never adopted the standard.)

**What comes back from the wallet is checked against what went in.** The wallet is handed bytes and
returns bytes, and nothing else compares the two, so `signedByPayer` requires the message to be
byte for byte the message that went out, the fee payer's slot to still be empty for the facilitator
to sign, and the payer's slot to have stopped being empty. A wallet that rewrote the transfer, or
signed something else entirely, fails there rather than at the chain with money in flight.

**One link is unverified**: nobody has yet made a real payment on this rail, so the wallet call and
the facilitator's acceptance of the assembled transaction have not been exercised against the live
chain. Everything up to the wallet is covered by the tests above.

### What the page tells you, and what it asks you

The network is in the top bar beside the wallet and the balance, with the chain's own mark, because
which network is selected decides what gets signed, what signs it and where the money goes. That is
the state of the session, not a detail of the card it happens to be described in. Pressing it opens
the same picker the wallet uses; the CAIP-2 id is under each name, because that is the string a
client has to send and somebody is here to copy it.

**The recipient check does not ask you to know an address by heart.** It exists to notice the
address CHANGING, and a tool that ships with a source ships with the address that source has always
paid to, so a preset declares its own (`knownPayTo`, per network) and the row compares against that.
Pinning one by hand still wins, for a source this tool does not know or for holding a quote to an
address of your choosing. It was an "unchecked" row nagging you to paste something you should never
have had to have; that was backwards.

Every button that starts something wears a spinner and its label says what is happening, from
"Asking the endpoint..." on the quote to "Waiting for your wallet..." on a signature. A button that
keeps its old label after a press is a button somebody presses twice, and on this page the second
press is a second payment request.

### Paying from a balance

A resource with a minimum payment leaves the difference behind whenever an order costs less than
the minimum, and that remainder is spendable. GrowVib's minimum is a dollar, so a wallet that has
placed six cheap orders can be holding most of six dollars. Without a way to spend it, every order
settles again: ten cheap things, ten minimums, and the rest stranded.

So the lab does both, and neither is a button you have to find. **Connecting a wallet** to a source
that publishes a sign-in reads the balance straight away: one ERC-4361 signature, no payment,
nothing on chain. It lands in the top bar beside the wallet, because that is where a person looks
for a balance, and a tool that cannot answer "what do I have here?" until you reach the third step
reads as a tool with no balance in it.

Declining that signature is a reasonable answer and is not treated as a failure. The badge then
offers it again, carries whatever the endpoint said about the last attempt, and pressing it asks
once more. **Pay from balance** gets its own credential the same way if there is none yet, so the
order never waits on a separate step either. The Source drawer keeps a sign-in for when you want
the credential on its own, and all three run the same action.

Both routes live in one card and their buttons in one row: **Pay $1.00**, **Sign without sending**,
**Pay from balance**. They were two cards, and the balance one moved above or below the quote
depending on which route was open. That was the wrong fix for the right problem, since somebody
looking at the action row saw a blocked button and a dry run beside it while the thing that would
actually have placed the order was a card away, off the bottom of the screen. Two routes to one
outcome belong side by side, where choosing between them is a glance rather than a scroll. When the
on-chain checks block, or the quote is on a network this lab cannot settle, the balance route takes
the primary styling and the row says why the checks do not apply to it.

**No domain mismatch.** An ERC-4361 message names the authority asking for the signature, and
every wallet compares that against the page in front of you. A resource that names itself there
gets a red "Domain Mismatch" on every honest sign-in, which is the warning nobody should be taught
to click through. So this lab's proxy forwards the page's own `Origin` (the browser sets it on the
call to `/proxy`; the proxy stands where the browser would have stood), and an endpoint that reads
it names the page: `localhost:4999 wants you to sign in`, matching what the wallet sees. GrowVib
does this for its own hosts and for any loopback address, and keeps naming itself for everything
else, so a phishing page still cannot get its own name into the message.

Where an endpoint does name something else, the page explains it, and only then: the authority is
read out of the message and compared with this page's host while the wallet dialog is opening, so
the explanation is on screen at the moment the warning is. A warning about a warning that never
comes is noise.

The failing on-chain balance check knows about this too. "Top up this wallet, or choose something
cheaper" is the right advice for a resource that only takes chain payments and the wrong advice for
one that is already holding your money, so where a balance exists the row says that instead. The
balance route carries none of the ten payment checks, because there is no signature, no recipient
and no chain for them to be about.

Three rules are the endpoint's and the lab follows them exactly:

- **The quote request never carries the credential.** On this endpoint a bearer token with no
  payment header _is_ the order, so attaching one to a price check would place an order. The quote
  stays anonymous, and the token appears only on the request somebody pressed a button to send.
- **The idempotency key follows what is being bought**, not when the button was pressed. A key per
  request would let a retry buy twice; a key per session would collide the moment the selection
  changes. `test/unit/agent.test.ts` pins both halves.
- **A balance that does not cover the order is not an error.** The endpoint answers with the
  ordinary 402, and the paying path above is still open.

And one the lab is careful not to get wrong: the amount on the quote is what the endpoint will
**settle**, which is its minimum whenever the order costs less. The order is charged its own price.
So the quote is an upper bound on a balance order and nothing else, the lab never shows it as the
price, and a balance under it is not a refusal: only the endpoint knows, its answer costs nothing,
and a 402 charges nothing.

The rails are the same as for signing: one payment in flight, a cooldown and a session cap. It
spends real money, so it is gated like spending real money.

### The checks

Passing checks are a count: _All 10 payment checks passed · View checks_. Failing checks are the
page, expanded, with the reason and what to do about it. Ten green rows with explanations are ten
rows nobody reads, which is how the one red row gets missed.

| Check                 | Why it is there                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipient             | The one mistake with no way back. Pin the address you expect and a quote naming anyone else is refused. Unpinned, it reports **unchecked** and stays that way                                                        |
| Token                 | The contract is asked its own `name()` and `symbol()`. Anyone can deploy a token called USDC                                                                                                                         |
| Amount                | Compared in atomic units against your limit, never as a decimal. A wrong power of ten is a 1000x error, and a float comparison is a ceiling that rounds                                                              |
| Signing domain        | The domain from the quote is hashed and compared to the separator the token itself reports. Signing under the wrong one produces a well formed signature the token rejects, with nothing in the error to explain why |
| Wallet balance        | Read from the token, not assumed                                                                                                                                                                                     |
| Authorization nonce   | `authorizationState()` at the contract: a used nonce can never settle                                                                                                                                                |
| Header parity         | The `PAYMENT-REQUIRED` header decoded against the body. A browser client reads one and a server-to-server client reads the other                                                                                     |
| Settlement simulation | An `eth_call` of the exact `transferWithAuthorization` the facilitator will make, with your real signature. If the token would refuse it, you find out here rather than with a payment in flight                     |

A failed check blocks signing, and the block is enforced in the handler as well as on the button: a
click dispatched past a disabled attribute ends in the same guard. `test/e2e/blocks.ts` forces
that click and asserts the wallet was never opened, because a check table that cannot fail is
decoration.

## Server checks

Around twenty-five checks over the payment request, what a browser client needs, how the endpoint
can be discovered, how it refuses bad input, and its MCP surface. Failures sort to the top, and the
report exports as markdown for an issue thread.

Two rules make it worth pasting anywhere:

- **A check that could not run reports `skip` and says why.** It is never folded into the pass
  count. A green report that quietly skipped the money checks is how a broken payment path ships
  with a badge on it.
- **Nothing here spends.** One probe sends a payment header carrying a signature nothing made,
  which cannot authorize a transfer at the token level, and it says so in its title. The checks
  that need real money are declared and skipped.

Every check has been watched going red: `fixtures/mock-x402.ts` breaks itself on demand, and
`test/unit/conformance.test.ts` turns each flaw on in turn and asserts that exactly the matching
check fails while a healthy server keeps it green. A checker nobody has watched fail is a checker
nobody should trust.

The same suite runs headless, which is how it belongs in CI:

```bash
node bin/x402-lab.ts check <url> --body '{"item":"report"}' --mcp <url> --markdown
node bin/x402-lab.ts check <url> --strict     # warnings fail the run too
```

Exit code 1 on any failure, 0 otherwise.

## Learn, History, Source

**Learn** is the protocol in the order you meet it, written for somebody who has just watched a
payment happen. **History** keeps every request of every run in this browser, and exports one as
markdown for a bug report. **Source** is where the requests go: the endpoint settings, discovery
over `/.well-known/x402`, a facilitator index, an MCP server card or an OpenAPI document, and what
the local proxy is allowed to reach.

The navigation rail holds navigation and nothing else. Where the requests go belongs to the source;
what you are willing to pay belongs to the payment, and sits next to it.

## Safety

The lab drives a wallet from a page, which is a shape that can be made to repeat itself: a double
click, a re-render that re-fires a handler, a tab left open on a source that later becomes
production. None of those need an attacker, so none of them are left to good intentions.

**Around the wallet** (`src/lib/modal.ts`, covered by `test/e2e/wallet.ts`): with two extensions
installed, `window.ethereum` is whichever one won the race to inject, so the page asks which one
should pay. Backing out of that question connects nothing, rather than falling back to the first in
the list.

**Around the payment** (`src/lib/guard.ts`, covered by `test/e2e/blocks.ts`):

- One payment in flight at a time, and a few seconds between payments. Nothing legitimate pays
  faster, so anything faster is a bug or a loop.
- A cap on payments per session. A tab that has paid ten times is either a test run that should be
  using simulation, or something nobody is watching.
- **No retries anywhere.** A retry on a paying request is a second payment; a retry on a quote is
  load somebody did not ask for.

**Around the proxy** (`server.ts`, covered by `test/unit/server.test.ts`):

1. It binds to loopback only.
2. It refuses any request whose `Host` header is not loopback, which is what stops a page on the
   open internet from reaching it by resolving its own domain to `127.0.0.1`.

**The page is served at `localhost`, not at `127.0.0.1`**, and the two are not interchangeable to a
wallet: several extensions will not inject into a bare IP origin at all, and one that does treats
the name and the address as separate origins with separate permissions, so a wallet approved on one
is a wallet missing on the other. It is also the name the endpoint's sign-in message will carry,
which is the whole point of reading it off the Origin. `X402_LAB_HOST` names a different interface when
`localhost` resolves somewhere inconvenient, and it is resolved and refused unless it is loopback,
before anything is bound. That check is the one that matters: the `Host` header check inside the
server is the DNS-rebinding fence and it only stops a browser, since a client that writes its own
headers walks straight past it. The page holds a session token and proxies to its allowlist, so it
stays on this machine.
3. It requires a session token minted at startup, which is readable only same-origin.
4. It forwards only to allowlisted origins. Add one with `X402_LAB_ALLOW=https://api.example.com`;
a preset's own origin is allowed automatically.

**Around what leaves the browser** (`src/lib/redact.ts`): a successful payment returns a token that
spends the balance it created, and the most natural thing to do with a run is paste it into an
issue. Exports are redacted by default, the count of what was removed is shown rather than hidden,
and the token is never rendered in full on screen.

Your limits are kept per source in this browser and never sent upstream. No private key ever
reaches this process, because there is none in it. The page fetches nothing from a CDN, including
fonts: it works offline, and nobody learns when you are using it.

## What it does not do

- **It does not verify a facilitator.** It reports what one said.
- **It does not replace testing against a real deployment.** A conformant 402 is not a correct
  money path.

## Repository

This is the tool's own repository, https://github.com/growvib/x402-mcp-lab, MIT licensed. It grew
inside GrowVib's private monorepo and was extracted with a fresh history; the monorepo keeps only a
Go test that pins this tool's payload against the server's own types. The Claude Code plugin that
installs GrowVib's public MCP endpoint lives next door at https://github.com/growvib/agent-plugins.
What a preset holds is public by construction: an origin, routes, and the recipient addresses the
endpoint itself publishes in its manifest. The Bazaar reader takes both the x402 v2 declaration
(`extensions.bazaar.info` plus `schema`) and the earlier flat `inputSchema`, so a resource on either
shape gets a form and a clean conformance report.

## Presets

`presets/*.json` name an origin, the resource path, an MCP endpoint, a sample body, and optionally
a catalog plus any wallet sign-in routes. `X402_LAB_PRESETS=fixture,growvib` picks which to load
and in which order; the first one is what the lab opens on, and it defaults to the demo server.

A `catalog` block is what makes the Choose step work, and it is all configuration: nothing in the
code knows what a GrowVib service is.

```jsonc
"catalog": {
  "list": "/v1/services?locale=en",       // query params you set stay set
  "service": "/v1/services/{id}?locale=en",
  "titleField": "name",                   // and idField, optionsField
  "searchParam": "search",                // plus pageParam, pageSizeParam
  "priceUnit": "per 1K",                  // what a catalog price is a price OF
  "facets": [
    { "param": "platform_key", "label": "Platform",
      "valuesPath": "/v1/services/platforms",
      "valueField": "key", "labelField": "name", "countField": "service_count" },
    { "param": "metric", "label": "What you are buying",
      "valuesPath": "/v1/services/metrics?platform_key={platform_key}",
      "dependsOn": "platform_key" }       // asked for only once a platform is chosen
  ],
  "fields": { "service": "service_id", "option": "service_option_id", "quantity": "quantity" }
}
```

A facet with no `valuesPath` reads its values from a `facets` array in the list response instead,
which is what the demo server does and what a small catalog can get away with.

## Tests

```bash
npm test                          # unit tests: no browser, no network beyond loopback
npx playwright install chromium   # once, for the browser specs
npm run test:e2e                  # builds the page, then drives it against a stub wallet
npm run verify                    # types, lint, unit and browser specs: what CI runs
```

The browser specs use Playwright's own Chromium. Set `CHROME_PATH` to drive a different build.

`test/e2e/catalog.ts` drives a forty-product catalog and asserts that the search, the chips and
the paging change what the ENDPOINT was asked, not what the page kept: the total has to move when
the search does, which it could not do if this were filtering twelve downloaded rows.

`test/unit/crypto.test.ts` pins keccak against published vectors, every function selector against
its published value, and the EIP-712 domain separator against the spec's own worked example. Those
numbers are what the simulation and the domain check rest on: a wrong selector would report "would
revert" for a perfectly good signature, and a false alarm on the most important row is what gets
the row switched off.

`node test/e2e/screenshots.ts [dir]` drives the same harness and captures every view and state
worth looking at, including the ones that only exist when something is wrong, which it produces by
breaking the demo server on purpose. It is how the design review deck is regenerated after a UI
change.

## Layout

```
server.ts               the local host and proxy
bin/x402-lab.ts         the headless runner
scripts/build.ts        bundles the page into dist/
src/                    the page
  app.ts                shell: source, wallet, run, routing
  views/playground.ts   the shell: which steps exist, which one is open
  views/playground/     one file per step, each beside its own actions
    state.ts            where the run is, and what is in the request body
    facts.ts            what the checks are checked against
    format.ts           how a value is written down, in one place
    catalog.ts          choose what to buy, and which setup of it
    request.ts          the request, and the handshake it starts
    payment.ts          the quote, the checks, the rails, the signature
    result.ts           what happened, as two separate facts
    mcp.ts              the same flow with the requirements in a tool result
  views/learn.ts        the protocol, in the order you meet it
  views/checks.ts       the server report
  views/orders.ts       what the paying wallet bought, read back
  views/history.ts      runs, and the redacted export
  views/source.ts       the source drawer and discovery
  lib/types.ts          the transport envelope and the source configuration
  lib/json.ts           reading untrusted JSON without trusting its shape
  lib/x402.ts           the protocol model (pure)
  lib/checks.ts         the payment checks (pure)
  lib/conformance.ts    the server suite (pure, one injected transport)
  lib/guard.ts          the rails around paying
  lib/redact.ts         what is stripped from anything copied out
  lib/catalog.ts        choosing what to buy, before what to send
  lib/keccak.ts         keccak256, so nothing here is a pasted constant
  lib/abi.ts            selectors, EIP-55, EIP-712, the EIP-3009 call
  lib/base58.ts         base58, for Solana addresses and signatures
  lib/solana.ts         the SPL transfer a Solana payment signs
  lib/wallet.ts         EIP-6963 discovery and the chain reads
  lib/solana-wallet.ts  Wallet Standard discovery and signing
  lib/mcp.ts            a minimal Streamable HTTP client
  lib/agent.ts          signing in, and paying from the balance that leaves
  lib/modal.ts          the one dialog, so nothing asks through window.prompt
  lib/ui.ts             hyperscript, and the one place motion is started
presets/                sources
fixtures/               the demo server, correct by default and breakable on demand
test/unit/              node:test, no browser
test/e2e/               Playwright against a stub wallet
```

Everything in `lib/` that can be pure is pure, which is why the page, the headless runner and the
tests give the same answers. `views/playground/` layers one way only: `state` and `format` know
nothing about the steps, the steps know about those two and about each other only where the flow
genuinely joins up, and the shell knows about all of them. There are no cycles, and the one fork
between HTTP and MCP lives in the shell rather than inside either step.

## What this tool holds itself to

The conventions are in the tests, not only in the prose, because a convention nothing checks has a
half life:

- **`test/unit/contrast.test.ts`** computes every text on surface pair in the palette, in both
  schemes, and fails under WCAG AA. The palette is declared once, as `light-dark()` pairs, so there
  is one place for a colour to be wrong.
- **`test/unit/standards.test.ts`** fails the build on the specific mistakes this codebase has
  already talked itself out of: a browser dialog (`prompt`, `alert`, `confirm`), anything fetched
  from the network to draw the page, raw HTML assignment outside `lib/ui.ts`, a hex colour outside
  the palette, a hard coded animation duration, a file over a thousand lines, and an em dash.
- **Motion** has one duration and one curve, and starts in exactly one place: a screen change.
  `prefers-reduced-motion` is honoured in JavaScript as well as CSS, so a transition is never
  started rather than started and overridden.
- **State is never carried by colour alone.** Every check row has a mark and a sentence, asserted
  in `test/e2e/checks.ts`.

## Contributing

Issues and pull requests are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the
bar a change has to clear. Report a vulnerability privately, as [SECURITY.md](SECURITY.md)
describes, never in a public issue. MIT licensed, see [LICENSE](LICENSE).
