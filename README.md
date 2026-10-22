# x402-listing-check

Check an [x402](https://x402.org) endpoint the way discovery services see it, before you list it.

```bash
npx x402-listing-check https://your-api.example.com/v1/paid-route
```

Nothing is paid: every request is an unpaid probe, the same kind registries send.

## Why

Shipping an x402 endpoint is easy. Getting it to show up properly in the CDP Bazaar, agentic.market, x402scan and x402-list is not, because each one reads a different part of your 402 response and drops what it doesn't like without telling you.

We ran it on the 200 busiest hosts in the CDP Bazaar (by unique payers, one route each, 2026-10-22). 196 answered the unpaid probe with a 402:

| Issue | Hosts |
|:---|:---:|
| No `iconUrl`: catalogs show a generic icon | 131 of 196 |
| `PAYMENT-REQUIRED` not exposed to browsers (CORS) | 131 of 196 |
| No `serviceName`: agentic.market lists the service without a name | 47 of 196 |
| No `tags` | 49 of 196 |
| Tags silently dropped by the Bazaar (more than 5, or too long) | 38 of 196 |
| Paid route missing from its own `/.well-known/x402` | 14 of 130 manifests |

Method, limits and the script that reproduces these numbers: [`scan/`](scan/).

## What it checks

| Section | Checks |
|:---|:---|
| **Host** | https, public hostname; x402-list.com's rules ($1 review fee on free compute hosts such as onrender.com or vercel.app, refusal of static hosts and dev tunnels) |
| **402 challenge** | the route answers `402` to an unpaid request (not `200`, `400`, `405`); response time (cold starts make agents give up); `PAYMENT-REQUIRED` exposed in CORS; x402 v1 (JSON body) and v2 (`PAYMENT-REQUIRED` header) |
| **Payment options** | CAIP-2 network ids, integer amounts in atomic units, price in dollars for USDC, valid `payTo`, the EIP-712 `extra.name` / `extra.version` EVM `exact` payments need, `maxTimeoutSeconds` |
| **Resource metadata** | `resource.url` matches what you called (catches `http://` behind a TLS-terminating proxy), description, mimeType, and `serviceName` / `tags` / `iconUrl` run through the Bazaar's own sanitizer, so you see what survives; the icon is fetched |
| **Well-known manifest** | fetches `/.well-known/x402` (any of the shapes deployed today: `resources`, `items`, `endpoints`, `routes`; URLs, `METHOD /path` strings or objects), checks the paid route is listed (`:param` / `{param}` templates match), and compares any `payTo`, network or price it restates with the live 402 |
| **Bazaar discovery** | `extensions.bazaar` present and validated with the official `@x402/extensions` validator; input shape, `routeTemplate` for path parameters, output example |
| **OpenAPI** | finds `/openapi.json` or `/.well-known/openapi.json` and probes every listed operation: registries expect a 402 from each, so a free route listed there looks broken; `x-payment-info`, `x-guidance` |
| **Bazaar index** | looks the resource up in the CDP Bazaar and shows when it was last updated and its 30-day calls and unique payers |

## Options

```
--method <M>    HTTP method of the paid route (default GET)
--body <json>   request body for POST routes that validate input before answering 402
--json          machine-readable output, for CI
--no-openapi    skip the OpenAPI probe
--no-bazaar     skip the CDP Bazaar lookup
--no-well-known skip the /.well-known/x402 manifest check
```

The exit code is `1` when a check fails, so it can gate a deploy:

```bash
npx x402-listing-check https://your-api.example.com/v1/paid-route --json > listing.json
```

## Example

```
$ npx x402-listing-check https://underindex-api.onrender.com/api/subculture/goth-ninja

Host
  ⚠️  underindex-api.onrender.com is a free compute host
       x402-list.com charges a one-off $1 (x402) review fee for these; a custom domain avoids it.

402 challenge
  ✅ answers 402 Payment Required (342 ms)
  ✅ x402 v2, read from the PAYMENT-REQUIRED header

Payment option 1
  ✅ exact on eip155:8453: $0.01 USDC

Resource metadata
  ✅ resource.url https://underindex-api.onrender.com/api/subculture/goth-ninja
  ✅ description (348 chars)
  ✅ serviceName "UnderIndex"
  ✅ tags: fashion, subcultures, grounding, rag, dataset
  ✅ iconUrl https://underindex-api.onrender.com/favicon.ico
  ✅ icon loads (image/png)

Bazaar discovery
  ✅ extension passes the official schema (@x402/extensions)
  ℹ️  input: http GET, path params name
  ✅ routeTemplate /api/subculture/:name
  ✅ output example present

Well-known manifest
  ℹ️  no /.well-known/x402

OpenAPI
  ✅ found /openapi.json (OpenAPI 3.1.0)
  ✅ GET /api/subculture answers 402

Bazaar index
  ✅ indexed as https://underindex-api.onrender.com/api/subculture/:name ("UnderIndex"), updated 2026-10-16, 30-day calls 3 from 2 payers

0 failed, 1 warnings, 15 passed
```

That endpoint is [UnderIndex](https://github.com/ascanioUnderIndex/underindex-api), the x402 API this tool came out of: every check here is something we got wrong first.

## Use it from code

```js
import { runChecks } from "x402-listing-check";

const results = await runChecks("https://your-api.example.com/v1/paid-route", { method: "GET" });
// [{ section, level: "pass" | "warn" | "fail" | "info", message, hint }]
```

## Notes

- Hosting rules for x402-list.com come from its submission docs and may change.
- The Bazaar lookup uses the public CDP discovery search; a resource appears there after its first payment settles through a facilitator that catalogs Bazaar metadata.
- Requires Node.js 20 or later.

MIT
