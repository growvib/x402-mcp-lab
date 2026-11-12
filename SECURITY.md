# Security policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue.

Use GitHub's private reporting form:
https://github.com/growvib/x402-mcp-lab/security/advisories/new

Include what you found, how to reproduce it, and what an attacker could do with it. Reports are
reviewed by the GrowVib team.

## In scope

The lab sits between a browser wallet and endpoints that take money, so these are in scope and
urgent:

- A way for a page, a server response, a tool description or a preset to make the lab sign or send
  a payment the person did not review, or to a recipient, amount or network other than the one the
  page showed.
- A way around the local proxy's fences: the loopback bind, the Host check, the per-session token,
  or the origin allowlist.
- Markup or script from a server response reaching the page as anything but text.
- A credential (an agent token, a signed payment) surviving the redacted export.

## Out of scope

- A server that fails a conformance check. Report that to the server's maintainers.
- Anything that needs the attacker to already control the person's machine or browser profile.
- The lab running on a non-loopback interface after the person deliberately reconfigured it to.
