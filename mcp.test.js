import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { checkMcpChallenge, checkWellKnown, parseMcpPaymentRequired, probeMcp } from "./checks.mjs";

const required = {
  x402Version: 2,
  error: "Payment required to access this resource",
  resource: { url: "mcp://tool/analyse", description: "Analyses one thing for agents that need a verified answer.", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }],
};

// A minimal MCP Streamable HTTP server; `mode` picks how the paid tool answers an unpaid call
let mode = "spec";
const seen = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const msg = JSON.parse(body);
  seen.push({ method: msg.method, session: req.headers["mcp-session-id"], version: req.headers["mcp-protocol-version"] });
  if (msg.id === undefined) return res.writeHead(202).end();
  const reply = (result) => {
    const json = JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...result });
    if (mode === "sse") res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${json}\n\n`);
    else res.writeHead(200, { "content-type": "application/json", ...(msg.method === "initialize" ? { "mcp-session-id": "s-1" } : {}) }).end(json);
  };
  if (msg.method === "initialize") return reply({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1.0.0" } } });
  if (msg.method === "tools/list") return reply({ result: { tools: [{ name: "analyse", inputSchema: { type: "object" } }] } });
  if (msg.method === "tools/call") {
    if (mode === "free") return reply({ result: { content: [{ type: "text", text: "here you go" }] } });
    if (mode === "rpc-error") return reply({ error: { code: -32602, message: "missing argument ticker" } });
    if (mode === "text-only") return reply({ result: { isError: true, content: [{ type: "text", text: JSON.stringify(required) }] } });
    return reply({ result: { isError: true, structuredContent: required, content: [{ type: "text", text: JSON.stringify(required) }] } });
  }
  reply({ error: { code: -32601, message: "method not found" } });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const URL_ = `http://127.0.0.1:${server.address().port}/mcp`;
const run = async (m, tool = "analyse") => {
  mode = m;
  const probe = await probeMcp(URL_, tool, {});
  return checkMcpChallenge({ url: URL_, tool, probe });
};
const msgs = (out) => out.map((r) => `${r.level}: ${r.message}`);

test("a spec-shaped payment-required tool result passes, with the price in dollars", async () => {
  const { results, challenge } = await run("spec");
  assert.equal(challenge.from, "tool result structuredContent");
  const out = msgs(results);
  assert.ok(out.some((m) => m.startsWith("pass: tools/call analyse asks for payment over HTTP 200 (")));
  assert.ok(out.includes("pass: PaymentRequired in structuredContent and content[0].text"));
  assert.ok(out.includes("pass: exact on eip155:8453: $0.01 USDC"));
  assert.ok(out.includes("pass: resource.url mcp://tool/analyse"));
  assert.deepEqual(results.filter((r) => r.level === "fail"), []);
  // The session id and negotiated protocol version are sent after initialize
  const call = seen.findLast((s) => s.method === "tools/call");
  assert.equal(call.session, "s-1");
  assert.equal(call.version, "2025-06-18");
});

test("reads answers sent as a text/event-stream", async () => {
  const { results } = await run("sse");
  assert.ok(msgs(results).includes("pass: PaymentRequired in structuredContent and content[0].text"));
});

test("flags results the MCP transport does not allow", async () => {
  assert.ok(msgs((await run("text-only")).results).includes("fail: PaymentRequired is only in content[0].text, not in structuredContent"));
  assert.ok(msgs((await run("free")).results).includes("fail: tools/call analyse answered without asking for payment"));
  assert.ok(msgs((await run("rpc-error")).results).includes("fail: tools/call analyse returned JSON-RPC error -32602: missing argument ticker"));
  assert.ok(msgs((await run("spec", "nope")).results).includes('fail: tools/list has no tool "nope"'));
});

test("parses PaymentRequired from structuredContent or from content[0].text", () => {
  assert.equal(parseMcpPaymentRequired({ isError: true, structuredContent: required }).structured, true);
  assert.equal(parseMcpPaymentRequired({ isError: true, content: [{ type: "text", text: JSON.stringify(required) }] }).from, "tool result content[0].text");
  assert.ok(parseMcpPaymentRequired({ content: [{ type: "text", text: "hello" }] }).error);
});

test("the manifest check finds an MCP tool and asks for its transport", async () => {
  const live = { version: 2, data: required };
  const realFetch = globalThis.fetch;
  const serve = (doc) => (globalThis.fetch = async () => new Response(JSON.stringify(doc), { status: 200 }));
  try {
    const url = "https://api.example.org/mcp";
    serve({ resources: [{ url: "/mcp", method: "POST" }] });
    let out = msgs(await checkWellKnown(url, "POST", live, { mcpTool: "analyse" }));
    assert.ok(out.includes("pass: MCP tool analyse (/mcp) is listed as /mcp"));
    assert.ok(out.includes("info: the entry does not declare its transport"));
    serve({ resources: [{ url: "mcp://tool/analyse", transport: "mcp", price: "$0.01" }] });
    out = msgs(await checkWellKnown(url, "POST", live, { mcpTool: "analyse" }));
    assert.ok(out.includes("pass: MCP tool analyse (/mcp) is listed as mcp://tool/analyse"));
    assert.ok(out.includes('pass: the entry declares transport "mcp"'));
    assert.ok(out.includes("pass: price match the live payment requirement"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("reads a host-level mcp endpoint in the manifest and its tool list", async () => {
  const live = { version: 2, data: required };
  const realFetch = globalThis.fetch;
  const serve = (doc) => (globalThis.fetch = async () => new Response(JSON.stringify(doc), { status: 200 }));
  try {
    const url = "https://api.example.org/mcp";
    serve({ resources: ["/v1/a"], mcp: { endpoint: "https://api.example.org/mcp", transport: "streamable-http", tools: ["other"] } });
    const out = msgs(await checkWellKnown(url, "POST", live, { mcpTool: "analyse" }));
    assert.ok(out.includes('pass: listed as the manifest\'s MCP endpoint (transport "streamable-http")'));
    assert.ok(out.includes("warn: the manifest's MCP tool list does not include analyse"));
    serve({ access: { type: "mcp", url: "https://api.example.org/mcp" } });
    assert.ok(msgs(await checkWellKnown(url, "POST", live, { mcpTool: "analyse" })).includes("pass: listed as the manifest's MCP endpoint"));
    // Keys seen in deployed manifests (October 2026)
    serve({ mcp: { remoteConnector: "https://api.example.org/mcp", remoteNote: "Streamable HTTP, no auth" } });
    assert.ok(msgs(await checkWellKnown(url, "POST", live, { mcpTool: "analyse" })).includes("pass: listed as the manifest's MCP endpoint"));
    serve({ mcp: { manifest: "https://api.example.org/.well-known/mcp", streamable_http: "https://api.example.org/mcp" } });
    assert.ok(msgs(await checkWellKnown(url, "POST", live, { mcpTool: "analyse" }))
      .includes('pass: listed as the manifest\'s MCP endpoint (transport "streamable-http")'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a price described in prose is not a payable MCP challenge", async () => {
  const probe = await probeMcp(URL_, "analyse", {});
  probe.reply = { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: '{"status":"payment_required","price":"$0.002 USDC"}' }] } };
  assert.ok(msgs(checkMcpChallenge({ url: URL_, tool: "analyse", probe }).results)
    .includes("fail: tools/call analyse describes a payment in text but returns no x402 PaymentRequired object"));
});
