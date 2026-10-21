import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBazaarExtension, checkChallenge, checkHost, parseChallenge } from "./checks.mjs";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const response = (status, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers) });
const levels = (results, section) => results.filter((r) => !section || r.section === section).map((r) => `${r.level}: ${r.message}`);

const URL_ = "https://api.example.org/v1/thing";
const v2 = {
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }],
  resource: { url: URL_, description: "Returns one verified thing record for agents that need it.", mimeType: "application/json",
    serviceName: "Example", tags: ["things"], iconUrl: "https://api.example.org/icon.png" },
};

test("reads a v2 challenge from the PAYMENT-REQUIRED header", () => {
  const c = parseChallenge(response(402, { "payment-required": b64(v2) }), "");
  assert.equal(c.version, 2);
  assert.equal(c.data.accepts.length, 1);
});

test("reads a v1 challenge from the JSON body", () => {
  const c = parseChallenge(response(402), JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "base" }] }));
  assert.equal(c.version, 1);
  assert.equal(c.from, "response body");
});

test("a clean v2 challenge passes, with the price in dollars", () => {
  const res = response(402, { "payment-required": b64(v2), "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" });
  const out = checkChallenge({ url: URL_, res, ms: 300, challenge: parseChallenge(res, "") });
  assert.deepEqual(out.filter((r) => r.level === "fail" || r.level === "warn"), []);
  assert.ok(levels(out).includes("pass: exact on eip155:8453: $0.01 USDC"));
});

test("flags the common listing mistakes", () => {
  const bad = structuredClone(v2);
  bad.accepts[0].extra = {};
  bad.resource.url = "http://api.example.org/v1/thing"; // proxy terminating TLS
  delete bad.resource.serviceName;
  bad.resource.tags = ["a", "b", "c", "d", "e", "f"];
  const res = response(402, { "payment-required": b64(bad) });
  const out = levels(checkChallenge({ url: URL_, res, ms: 15_000, challenge: parseChallenge(res, "") }));
  for (const expected of [
    "warn: first response took 15.0 s",
    "warn: PAYMENT-REQUIRED is not in Access-Control-Expose-Headers",
    "fail: extra.name / extra.version missing",
    "fail: resource.url says http:// but you called https://",
    "warn: no serviceName",
    "warn: tags dropped by the Bazaar: f",
  ]) assert.ok(out.includes(expected), `missing: ${expected}\n${out.join("\n")}`);
});

test("non-EVM networks are not held to strict CAIP-2; decimal amounts are flagged", () => {
  const other = structuredClone(v2);
  other.accepts[0] = { ...other.accepts[0], network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", amount: "0.002" };
  const res = response(402, { "payment-required": b64(other), "access-control-expose-headers": "PAYMENT-REQUIRED" });
  const out = levels(checkChallenge({ url: URL_, res, ms: 100, challenge: parseChallenge(res, "") }));
  assert.ok(!out.some((m) => m.includes("not a CAIP-2 id")), out.join("\n"));
  assert.ok(out.includes('warn: amount "0.002" looks like a decimal'));
  const evm = structuredClone(v2);
  evm.accepts[0].network = "eip155:base";
  const res2 = response(402, { "payment-required": b64(evm) });
  assert.ok(levels(checkChallenge({ url: URL_, res: res2, ms: 100, challenge: parseChallenge(res2, "") })).includes('fail: network "eip155:base" is not a CAIP-2 id'));
});

test("a free route answering 200 fails", () => {
  const res = response(200);
  const out = levels(checkChallenge({ url: URL_, res, ms: 100, challenge: parseChallenge(res, "{}") }));
  assert.ok(out.includes("fail: answers 200 without payment"));
});

test("hosting rules follow x402-list.com", () => {
  assert.equal(checkHost("https://x.onrender.com/a")[0].level, "warn");
  assert.equal(checkHost("https://me.github.io/a")[0].level, "fail");
  assert.equal(checkHost("https://abc.ngrok-free.app/a")[0].level, "fail");
  assert.equal(checkHost("http://localhost:3000/a").some((r) => r.level === "fail"), true);
  assert.equal(checkHost("https://api.example.org/a")[0].level, "pass");
  assert.equal(checkHost("https://endpoint-a-pagamento/a")[0].level, "fail", "a bare name is not a public host");
});

test("a challenge without the bazaar extension is not indexable", () => {
  const res = response(402, { "payment-required": b64(v2) });
  const out = checkBazaarExtension(parseChallenge(res, ""));
  assert.equal(out[0].level, "fail");
});
