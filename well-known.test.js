import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkWellKnown, manifestEntries, routeMatches } from "./checks.mjs";

const ORIGIN = "https://api.example.org";
const URL_ = `${ORIGIN}/v1/thing/42`;
const live = {
  version: 2,
  data: {
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1111111111111111111111111111111111111111" }],
    resource: { url: URL_, description: "One thing." },
  },
};
const realFetch = globalThis.fetch;
const serve = (status, body) => {
  globalThis.fetch = async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
};
afterEach(() => (globalThis.fetch = realFetch));
const msgs = (out) => out.map((r) => `${r.level}: ${r.message}`);

test("reads every entry shape deployed manifests use", () => {
  const entries = manifestEntries({
    resources: ["https://api.example.org/a", "POST /b", { resource: "https://api.example.org/c" }, { resource: { url: "/d", method: "get" } }],
    items: [{ url: "/e" }],
    endpoints: [{ path: "/f", method: "PUT" }],
  }, ORIGIN);
  assert.deepEqual(entries.map((e) => `${e.method ?? "*"} ${e.url}`), [
    "* https://api.example.org/a", "POST https://api.example.org/b", "* https://api.example.org/c",
    "GET https://api.example.org/d", "* https://api.example.org/e", "PUT https://api.example.org/f",
  ]);
});

test("reads route maps, service lists, root accepts and inline OpenAPI", () => {
  const show = (doc) => manifestEntries(doc, ORIGIN).map((e) => `${e.method ?? "*"} ${e.url}`);
  assert.deepEqual(show({
    baseUrl: "https://api.example.org/v2",
    routes: { "POST /a": { accepts: [] }, search: { path: "/b" } },
    endpoints: { "/c": { method: "get" } },
    services: [{ id: "x", endpoint: "https://api.example.org/d", method: "POST" }],
    tools: [{ slug: "y", endpoint: "/e" }],
    accepts: [{ scheme: "exact", resource: "/f" }, { scheme: "exact" }],
  }), [
    "GET https://api.example.org/c", "POST https://api.example.org/a", "* https://api.example.org/b",
    "POST https://api.example.org/d", "* https://api.example.org/e", "* https://api.example.org/f",
  ]);
  assert.deepEqual(show({ openapi: "3.1.0", servers: [{ url: "https://api.example.org/api" }], paths: { "/g/{id}": { post: {}, parameters: [] } } }),
    ["POST https://api.example.org/api/g/%7Bid%7D"]);
});

test("accepts multi-method entries and does not blame paginated manifests", async () => {
  serve(200, { base_url: ORIGIN, endpoints: [{ path: "/v1/thing/{id}", method: "GET+POST", price_usdc: 0.01 }, { path: "/v1/thing/{id}", method: "GET+POST" }] });
  const out = msgs(await checkWellKnown(URL_, "GET", live));
  assert.ok(out.includes("pass: found /.well-known/x402 (1 route)"));
  assert.ok(out.includes("pass: price match the live 402"));
  serve(200, { items: ["/other"], pagination: { next: "?page=2" } });
  assert.ok(msgs(await checkWellKnown(URL_, "GET", live)).includes("info: GET /v1/thing/42 is not on the first page of the manifest"));
});

test("compares prices given as objects and in x-payment-info", async () => {
  serve(200, { openapi: "3.1.0", paths: { "/v1/thing/{id}": { get: { "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.02" } } } } } });
  assert.ok(msgs(await checkWellKnown(URL_, "GET", live)).includes("warn: manifest price $0.02 differs from the 402 ($0.01)"));
  serve(200, { tools: [{ endpoint: "/v1/thing/:id", price: { amount: 0.01, currency: "USDC", type: "fixed" } }] });
  assert.ok(msgs(await checkWellKnown(URL_, "GET", live)).includes("pass: price match the live 402"));
});

test("matches :param and {param} templates, not prefixes", () => {
  assert.ok(routeMatches(`${ORIGIN}/v1/thing/:id`, URL_));
  assert.ok(routeMatches(`${ORIGIN}/v1/thing/{id}`, URL_));
  assert.ok(routeMatches(`${ORIGIN}/v1/thing/42/`, `${URL_}?x=1`));
  assert.ok(!routeMatches(`${ORIGIN}/v1`, URL_));
  assert.ok(!routeMatches("https://other.example.org/v1/thing/:id", URL_));
});

test("no manifest is information, not a failure", async () => {
  serve(404, "not found");
  assert.deepEqual(msgs(await checkWellKnown(URL_, "GET", live)), ["info: no /.well-known/x402"]);
});

test("terms that agree with the live 402 pass", async () => {
  serve(200, { resources: [{ resource: `${ORIGIN}/v1/thing/:id`, method: "GET", price: "$0.01", network: "eip155:8453",
    payTo: "0x1111111111111111111111111111111111111111" }] });
  const out = msgs(await checkWellKnown(URL_, "GET", live));
  assert.ok(out.includes("pass: payTo, network, price match the live 402"), out.join("\n"));
});

test("stale price, payTo and network in the manifest are flagged", async () => {
  serve(200, { payTo: "0x2222222222222222222222222222222222222222", resources: [
    { url: "/v1/thing/{id}", accepts: [{ network: "eip155:84532", price: "$0.05" }] }] });
  const out = msgs(await checkWellKnown(URL_, "GET", live));
  for (const expected of [
    "warn: payTo in the manifest differs from the 402",
    "warn: manifest networks (eip155:84532) differ from the 402 (eip155:8453)",
    "warn: manifest price $0.05 differs from the 402 ($0.01)",
  ]) assert.ok(out.includes(expected), `missing: ${expected}\n${out.join("\n")}`);
});

test("a paid route missing from the manifest is flagged", async () => {
  serve(200, { resources: ["/v1/other"] });
  const out = msgs(await checkWellKnown(URL_, "GET", live));
  assert.ok(out.includes("warn: GET /v1/thing/42 is not listed"), out.join("\n"));
});

test("vague network labels are reported, not compared", async () => {
  serve(200, { network: "mainnet", resources: ["GET /v1/thing/:id"] });
  const out = msgs(await checkWellKnown(URL_, "GET", live));
  assert.ok(out.some((m) => m.startsWith('info: manifest names the network as "mainnet"')), out.join("\n"));
  assert.ok(!out.some((m) => m.startsWith("warn")), out.join("\n"));
});
