# Scan of busy x402 hosts

```bash
node scan/scan.mjs 200
```

**Which hosts.** The CDP Bazaar discovery list, first 5,000 resources (of about 30,000), grouped by host and ranked by the 30-day unique payers the Bazaar reports. For each of the top 200 hosts the scan takes the route with the most payers. Routes with path parameters are filled with the example values from their own Bazaar extension; routes that stay abstract are skipped.

**How.** Every route is probed once, unpaid, with the HTTP method and example body its Bazaar extension declares (the same request a registry can build). Then `/.well-known/x402` is fetched and compared with the live 402. OpenAPI probing and the Bazaar lookup are off. Nothing is paid and no host is named in the output.

## Results, 2026-10-22

| Check | Hosts |
|:---|:---:|
| Answer the unpaid probe with 402 | 196 of 200 |
| No iconUrl | 131 of 196 |
| PAYMENT-REQUIRED not exposed in CORS | 131 of 196 |
| No serviceName | 47 of 196 |
| No tags | 49 of 196 |
| Tags dropped by the Bazaar sanitizer | 38 of 196 |
| Extension rejected by the official validator | 7 of 196 |
| Serve /.well-known/x402 | 130 of 200 |
| Manifest lists the probed paid route | 125 of 130 |
| Manifest repeats payment terms (payTo, network or price) | 54 of 130 |
| Repeated terms disagree with the live 402 | 0 of 54 |

The same script run twice on 2026-10-22 gave identical counts.

## Reading it

- **Presentation metadata is the common gap.** Two thirds of busy hosts have no icon and a quarter no name or tags, and one in five loses tags to the Bazaar sanitizer (more than 5, or longer than 32 characters) without any error.
- **Manifests mostly point, they rarely restate.** 76 of the 130 manifests give no payment terms for the probed route (plain URLs, `METHOD /path` strings, or objects without terms). Where terms are restated, none disagreed with the live 402 on this sample, so drift between the two documents is not yet a measured problem. Routes missing from the manifest are rarer than they first looked: 4 of 130, checked by hand, plus 1 paginated manifest where the route may be on a later page.
- **The shapes are fragmented.** Routes sit under `resources`, `items`, `endpoints`, `routes`, `services`, `tools` or `accepts`, as lists or as maps keyed by route, with methods written as `GET`, `GET+POST` or arrays; one host serves a whole OpenAPI document at the well-known path. A first version of the checker read only four of these shapes and reported 14 missing routes: 9 were listed in shapes it did not read, 1 is on a paginated manifest.
- **Matching is lenient on purpose.** A route counts as listed if the manifest has the same host and path, with `:param` / `{param}` segments matching any value and the method matching when the manifest gives one. Price is compared only for USDC and only when both sides state an exact amount.

## Limits

- One route per host, so per-route problems on other routes are not counted.
- The Bazaar ranks resources it has seen settle through its facilitator; hosts that settle elsewhere are underrepresented.
- Entries in shapes other than the ones above are not read, which can only undercount "listed". Paginated manifests are read up to the first page only.
