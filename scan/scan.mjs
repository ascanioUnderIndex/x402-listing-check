// Reproducible scan behind the numbers in scan/README.md.
// Takes the hosts with the most unique payers among the first 5,000 CDP Bazaar resources, one route per host
// (the one with the most payers), probes it unpaid with the method and example body its own Bazaar extension
// declares, checks /.well-known/x402 against the live 402, and prints aggregate counts. No host is named.
// Run: node scan/scan.mjs [hosts=200]      (raw results go to scan/results.json, which is not committed)
import fs from "node:fs";
import { runChecks } from "../checks.mjs";

const N = Number(process.argv[2] || 200);
const PAGES = 5;
const dir = new URL(".", import.meta.url).pathname;

const items = [];
for (let page = 0; page < PAGES; page++) {
  const res = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1000&offset=${page * 1000}`);
  items.push(...(await res.json()).items);
}

const byHost = new Map();
for (const it of items) {
  const input = it.extensions?.bazaar?.info?.input ?? {};
  let url = it.resource;
  // Fill :param templates from the extension's own example values; routes left abstract are skipped
  for (const [k, v] of Object.entries(input.pathParams ?? {})) url = url.replace(`:${k}`, encodeURIComponent(v));
  if (/\/:[A-Za-z_]/.test(url)) continue;
  const payers = it.quality?.l30DaysUniquePayers ?? 0;
  const host = new URL(url).host;
  if (byHost.has(host) && byHost.get(host).payers >= payers) continue;
  const query = new URLSearchParams(Object.entries(input.queryParams ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString();
  if (query && !url.includes("?")) url += `?${query}`;
  const method = (input.method || "GET").toUpperCase();
  byHost.set(host, { url, payers, method, body: method === "GET" ? undefined : JSON.stringify(input.body ?? {}) });
}
const picks = [...byHost.values()].sort((a, b) => b.payers - a.payers).slice(0, N);

const results = [];
let next = 0;
const warnLog = console.warn;
console.warn = () => {}; // the schema validator logs "unknown format" notices
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < picks.length) {
    const p = picks[next++];
    results.push({ ...p, results: await runChecks(p.url, { method: p.method, body: p.body, openapi: false, bazaar: false }) });
    process.stderr.write(`\r${results.length}/${picks.length}`);
  }
}));
console.warn = warnLog;
fs.writeFileSync(dir + "results.json", JSON.stringify({ at: new Date().toISOString(), results }, null, 1));

const has = (r, section, test) => r.results.some((x) => (!section || x.section === section) && test(x.message));
const count = (list, section, test) => list.filter((r) => has(r, section, test)).length;
const paid = results.filter((r) => has(r, "402 challenge", (m) => m.startsWith("answers 402")));
const manifests = results.filter((r) => has(r, "Well-known manifest", (m) => m.startsWith("found /.well-known")));
const compared = manifests.filter((r) => has(r, "Well-known manifest", (m) => m.endsWith("match the live 402") || /^(payTo in the manifest|manifest networks|manifest price)/.test(m)));
const mismatched = compared.filter((r) => has(r, "Well-known manifest", (m) => /^(payTo in the manifest|manifest networks|manifest price)/.test(m)));

const rows = [
  [`Answer the unpaid probe with 402`, results.length, paid.length],
  [`No iconUrl`, paid.length, count(paid, null, (m) => m === "no iconUrl")],
  [`PAYMENT-REQUIRED not exposed in CORS`, paid.length, count(paid, null, (m) => m.startsWith("PAYMENT-REQUIRED is not in"))],
  [`No serviceName`, paid.length, count(paid, null, (m) => m === "no serviceName")],
  [`No tags`, paid.length, count(paid, null, (m) => m === "no tags")],
  [`Tags dropped by the Bazaar sanitizer`, paid.length, count(paid, null, (m) => m.startsWith("tags dropped"))],
  [`Extension rejected by the official validator`, paid.length, count(paid, null, (m) => m.startsWith("the official validator"))],
  [`Serve /.well-known/x402`, results.length, manifests.length],
  [`Manifest lists the probed paid route`, manifests.length, count(manifests, "Well-known manifest", (m) => m.includes(" is listed as "))],
  [`Manifest repeats payment terms (payTo, network or price)`, manifests.length, compared.length],
  [`Repeated terms disagree with the live 402`, compared.length, mismatched.length],
];
console.log(`\n\nScan of ${results.length} hosts, ${new Date().toISOString().slice(0, 10)}\n`);
console.log("| Check | Hosts |\n|:---|:---:|");
for (const [label, of, n] of rows) console.log(`| ${label} | ${n} of ${of} |`);
