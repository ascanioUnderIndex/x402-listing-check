#!/usr/bin/env node
// x402-listing-check <url> [--method POST] [--body '{...}'] [--json] [--no-openapi] [--no-bazaar]
import { runChecks } from "./checks.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = args.find((a, i) => !a.startsWith("--") && !["--method", "--body"].includes(args[i - 1]));

if (!url || flag("--help") || flag("-h")) {
  console.log(`Usage: x402-listing-check <paid-endpoint-url> [options]

Checks an x402 endpoint the way discovery services see it: the 402 challenge, payment terms,
Bazaar metadata (serviceName, tags, icon, discovery extension), the OpenAPI paths registries
probe, hosting rules of x402-list.com, and whether the CDP Bazaar has indexed it.

Options:
  --method <M>    HTTP method of the paid route (default GET)
  --body <json>   request body for POST routes that validate input before answering 402
  --json         machine-readable output
  --no-openapi    skip the OpenAPI probe
  --no-bazaar     skip the CDP Bazaar lookup

Nothing is paid: every request is unauthenticated.`);
  process.exit(url ? 0 : 1);
}

const results = await runChecks(url, {
  method: (option("--method") || "GET").toUpperCase(),
  body: option("--body"),
  openapi: !flag("--no-openapi"),
  bazaar: !flag("--no-bazaar"),
});

if (flag("--json")) {
  console.log(JSON.stringify({ url, results }, null, 2));
} else {
  const icon = { pass: "✅", warn: "⚠️ ", fail: "❌", info: "ℹ️ " };
  let section = null;
  console.log(`\nx402-listing-check ${url}`);
  for (const r of results) {
    if (r.section !== section) {
      section = r.section;
      console.log(`\n${section}`);
    }
    console.log(`  ${icon[r.level]} ${r.message}`);
    if (r.hint && r.level !== "pass") console.log(`       ${r.hint}`);
  }
  const n = (l) => results.filter((r) => r.level === l).length;
  console.log(`\n${n("fail")} failed, ${n("warn")} warnings, ${n("pass")} passed\n`);
}
process.exit(results.some((r) => r.level === "fail") ? 1 : 0);
