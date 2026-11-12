# Changelog

All notable changes to the lab. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

## 0.1.0 (2026-11-12)

The first public release, extracted from the GrowVib monorepo with a fresh history.

- A playground that walks one x402 payment end to end: choose from a source's catalog, build the
  request from its Bazaar declaration, read the 402, check every field the wallet is about to sign,
  sign on Base (EIP-3009) or Solana (an SPL transfer the facilitator pays the fee for), and read
  back what was created.
- The same flow over MCP Streamable HTTP, with the requirements arriving in a tool result.
- Paying from a balance with an agent token, signing in with a wallet message that moves no funds,
  and an Orders view that reads back what the paying wallet bought.
- A server conformance suite, in the page and headless (`npm run check -- <url>`), every check of
  which is shown failing against the bundled demo server.
- Guards around paying: a spend limit, a pinned recipient, a mainnet confirmation, and a redacted
  export for anything copied out.
- Written in strict TypeScript, run from source on Node 22.18 or newer, with no runtime
  dependencies.
