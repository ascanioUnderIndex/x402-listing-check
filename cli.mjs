#!/usr/bin/env node
// x402-listing-check <url> [--method POST] [--body '{...}'] [--mcp-tool <name>] [--mcp-args '{...}'] [--json]
//   [--no-openapi] [--no-bazaar] [--no-well-known]
import { runChecks } from "./checks.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUED = ["--method", "--body", "--mcp-tool", "--mcp-args"];
const url = args.find((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]));

if (!url || flag("--help") || flag("-h")) {
  console.log(`Usage: x402-listing-check <paid-endpoint-url> [options]

Checks an x402 endpoint the way discovery services see it: the 402 challenge, payment terms,
Bazaar metadata (serviceName, tags, icon, discovery extension), /.well-known/x402 against the
live 402, the OpenAPI paths registries probe, hosting rules of x402-list.com, and whether the
CDP Bazaar has indexed it.

Options:
  --method <M>    HTTP method of the paid route (default GET)
  --body <json>   request body for POST routes that validate input before answering 402
  --mcp-tool <n>  the URL is an MCP endpoint (e.g. https://host/mcp): call this paid tool over the
                  x402 MCP transport, which signals payment in the tool result instead of a 402
  --mcp-args <j>  arguments for that tool call, as JSON (default {})
  --json          machine-readable output
  --no-openapi    skip the OpenAPI probe
  --no-bazaar     skip the CDP Bazaar lookup
  --no-well-known skip the /.well-known/x402 manifest check

Nothing is paid: every request is unauthenticated.`);
  process.exit(url ? 0 : 1);
}

let mcpArgs = {};
if (option("--mcp-args")) {
  try {
    mcpArgs = JSON.parse(option("--mcp-args"));
  } catch {
    console.error("--mcp-args is not valid JSON");
    process.exit(1);
  }
}

const results = await runChecks(url, {
  method: (option("--method") || "GET").toUpperCase(),
  body: option("--body"),
  mcpTool: option("--mcp-tool"),
  mcpArgs,
  openapi: !flag("--no-openapi"),
  bazaar: !flag("--no-bazaar"),
  wellKnown: !flag("--no-well-known"),
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
