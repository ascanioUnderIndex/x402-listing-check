// Checks an x402 endpoint the way discovery services see it: the 402 challenge, the payment terms,
// the Bazaar metadata that catalogs such as agentic.market display, the OpenAPI paths registries probe,
// and whether the CDP Bazaar has indexed it. Each check returns { section, level, message, hint }.
import {
  sanitizeResourceServiceMetadata,
  validateDiscoveryExtension,
} from "@x402/extensions/bazaar";

export const BAZAAR_SEARCH = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";

// USDC per network, so prices can be shown in dollars and odd assets flagged
const USDC = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "eip155:10": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "eip155:43114": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
const V1_NETWORKS = { base: "eip155:8453", "base-sepolia": "eip155:84532", solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" };

// Hosts x402-list.com charges a $1 review fee for, or refuses (from its submission docs, October 2026)
const FREE_COMPUTE = ["vercel.app", "workers.dev", "pages.dev", "netlify.app", "onrender.com", "railway.app", "fly.dev",
  "herokuapp.com", "replit.app", "glitch.me", "deno.dev", "pythonanywhere.com", "firebaseapp.com", "web.app", "eu.org",
  "is-a.dev", "duckdns.org", "nip.io", "sslip.io", "hf.space", "koyeb.app", "codesandbox.io"];
const STATIC_ONLY = ["github.io", "gitlab.io", "surge.sh", "neocities.org", "r2.dev"];
const TUNNELS = ["ngrok.io", "ngrok-free.app", "ngrok.app", "trycloudflare.com", "localhost.run", "serveo.net"];
const onDomain = (host, list) => list.some((d) => host === d || host.endsWith("." + d));

const ok = (section, message) => ({ section, level: "pass", message });
const warn = (section, message, hint) => ({ section, level: "warn", message, hint });
const fail = (section, message, hint) => ({ section, level: "fail", message, hint });
const info = (section, message) => ({ section, level: "info", message });

async function timedFetch(url, init = {}, timeoutMs = 60_000) {
  const started = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { res, ms: Date.now() - started };
}

function decodeBase64Json(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** The 402 challenge: v2 sends it base64-encoded in PAYMENT-REQUIRED, v1 sends it as the JSON body. */
export function parseChallenge(res, bodyText) {
  const header = res.headers.get("payment-required");
  if (header) {
    const decoded = decodeBase64Json(header);
    return decoded ? { version: decoded.x402Version ?? 2, data: decoded, from: "PAYMENT-REQUIRED header" } : { error: "PAYMENT-REQUIRED header is not base64 JSON" };
  }
  try {
    const body = JSON.parse(bodyText);
    if (body && Array.isArray(body.accepts)) return { version: body.x402Version ?? 1, data: body, from: "response body" };
  } catch {}
  return { error: "no PAYMENT-REQUIRED header and no x402 JSON body" };
}

export function checkHost(url) {
  const S = "Host";
  const { hostname, protocol } = new URL(url);
  const out = [];
  if (protocol !== "https:") out.push(fail(S, `URL uses ${protocol.replace(":", "")}`, "Directories and most agents expect https."));
  if (hostname === "localhost" || /^[\d.]+$/.test(hostname) || hostname.includes(":") || !hostname.includes(".")) {
    out.push(fail(S, `${hostname} is not a public hostname`, "Deploy to a public domain before listing."));
  } else if (onDomain(hostname, TUNNELS)) {
    out.push(fail(S, `${hostname} is a dev tunnel`, "x402-list.com rejects tunnels at any price; the URL dies when the tunnel closes."));
  } else if (onDomain(hostname, STATIC_ONLY)) {
    out.push(fail(S, `${hostname} is static-only hosting`, "A static host cannot answer 402; x402-list.com rejects it."));
  } else if (onDomain(hostname, FREE_COMPUTE)) {
    out.push(warn(S, `${hostname} is a free compute host`, "x402-list.com charges a one-off $1 (x402) review fee for these; a custom domain avoids it."));
  } else {
    out.push(ok(S, `${hostname} is a custom domain`));
  }
  return out;
}

export function checkChallenge({ url, res, ms, challenge }) {
  const S = "402 challenge";
  const out = [];
  if (res.status === 402) out.push(ok(S, `answers 402 Payment Required (${ms} ms)`));
  else if (res.ok) out.push(fail(S, `answers ${res.status} without payment`, "The paid route must answer 402 to an unpaid request; registries treat anything else as not x402."));
  else if (res.status === 405) out.push(fail(S, `answers 405 Method Not Allowed`, "The paid route uses another method; try --method POST."));
  else if (res.status === 400 || res.status === 422) out.push(fail(S, `answers ${res.status} instead of 402`, "The route validates input before charging. Pass a valid body with --body; registries probe with the example body from your Bazaar extension, so keep that example valid."));
  else out.push(fail(S, `answers ${res.status} instead of 402`, "Probe the exact paid URL, with valid parameters."));
  if (ms > 10_000) out.push(warn(S, `first response took ${(ms / 1000).toFixed(1)} s`, "Looks like a cold start. Many agents give up before that; keep the service warm (an uptime pinger every 5-10 min)."));

  const expose = (res.headers.get("access-control-expose-headers") || "").toLowerCase();
  if (challenge.data && challenge.version >= 2 && !expose.includes("payment-required")) {
    out.push(warn(S, "PAYMENT-REQUIRED is not in Access-Control-Expose-Headers", "Browser-based agents cannot read the challenge. Expose PAYMENT-REQUIRED and PAYMENT-RESPONSE in CORS."));
  }

  if (challenge.error) {
    out.push(fail(S, challenge.error, "Return the x402 PaymentRequired object (v2: base64 JSON in the PAYMENT-REQUIRED header)."));
    return out;
  }
  out.push(ok(S, `x402 v${challenge.version}, read from the ${challenge.from}`));
  const accepts = challenge.data.accepts;
  if (!Array.isArray(accepts) || !accepts.length) {
    out.push(fail(S, "accepts[] is empty", "List at least one payment option."));
    return out;
  }

  accepts.forEach((a, i) => {
    const T = `Payment option ${i + 1}`;
    const network = challenge.version >= 2 ? a.network : V1_NETWORKS[a.network] ?? a.network;
    // Strict for EVM only: other chains (e.g. Algorand genesis hashes) use references CAIP-2 does not strictly allow
    if (challenge.version >= 2 && (!/^[-a-z0-9]{3,8}:.+$/.test(a.network || "") || (a.network.startsWith("eip155:") && !/^eip155:\d+$/.test(a.network)))) {
      out.push(fail(T, `network "${a.network}" is not a CAIP-2 id`, "v2 uses ids such as eip155:8453 (Base) or eip155:84532 (Base Sepolia)."));
    }
    const amount = challenge.version >= 2 ? a.amount : a.maxAmountRequired;
    const usdc = USDC[network] && USDC[network].toLowerCase() === String(a.asset || "").toLowerCase();
    if (/^\d*\.\d+$/.test(String(amount ?? ""))) out.push(warn(T, `amount "${amount}" looks like a decimal`, "x402 amounts are integers in the asset's atomic units: $0.002 in USDC (6 decimals) is \"2000\"."));
    else if (!/^\d+$/.test(String(amount ?? ""))) out.push(fail(T, `amount "${amount}" is not an integer in atomic units`));
    else out.push(ok(T, `${a.scheme ?? "?"} on ${network}: ${usdc ? `$${(Number(amount) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} USDC` : `${amount} units of ${a.asset}`}`));
    if (a.asset && USDC[network] && !usdc) out.push(warn(T, `asset ${a.asset} is not USDC on ${network}`, "Most x402 clients only hold USDC; check this is intended."));
    if (network?.startsWith("eip155:")) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(a.payTo || "")) out.push(fail(T, `payTo "${a.payTo}" is not an EVM address`));
      else if (/^0x0{40}$/i.test(a.payTo)) out.push(fail(T, "payTo is the zero address", "Payments would be burned."));
      if (a.scheme === "exact" && !(a.extra?.name && a.extra?.version)) {
        out.push(fail(T, "extra.name / extra.version missing", "EVM exact payments sign an EIP-712 domain; for USDC on Base use { name: \"USD Coin\", version: \"2\" }."));
      }
    }
    if (!a.maxTimeoutSeconds) out.push(warn(T, "maxTimeoutSeconds missing", "Clients use it to bound how long a signed authorization stays valid."));
  });

  if (challenge.version >= 2) out.push(...checkResource(url, challenge.data.resource));
  return out;
}

function checkResource(url, resource) {
  const S = "Resource metadata";
  const out = [];
  if (!resource) return [fail(S, "resource object missing", "v2 challenges carry resource { url, description, mimeType }.")];
  try {
    const r = new URL(resource.url), u = new URL(url);
    if (r.protocol !== u.protocol) out.push(fail(S, `resource.url says ${r.protocol}// but you called ${u.protocol}//`, "Usually a proxy terminating TLS (Render, Heroku, Fly). Trust X-Forwarded-Proto, e.g. Express app.set(\"trust proxy\", true)."));
    else if (r.host !== u.host) out.push(warn(S, `resource.url host ${r.host} differs from ${u.host}`, "Catalogs list the host in resource.url."));
    else out.push(ok(S, `resource.url ${resource.url}`));
  } catch {
    out.push(fail(S, `resource.url "${resource.url}" is not a URL`));
  }
  if (!resource.description) out.push(warn(S, "no description", "Catalogs and agents rank and choose services by it. Say what the call returns and when to use it."));
  else if (resource.description.length < 40) out.push(warn(S, `description is short (${resource.description.length} chars)`, "Agents pick tools by this text; one or two full sentences work better."));
  else out.push(ok(S, `description (${resource.description.length} chars)`));
  if (!resource.mimeType) out.push(warn(S, "no mimeType", "Set it, e.g. application/json."));

  // The same sanitizer the facilitator applies: fields that fail it are dropped from the catalog silently
  const kept = sanitizeResourceServiceMetadata(resource);
  if (!resource.serviceName) out.push(warn(S, "no serviceName", "Without it agentic.market shows no name and guesses one from the domain. Max 32 printable ASCII chars."));
  else if (!kept.serviceName) out.push(fail(S, `serviceName "${resource.serviceName}" is dropped by the Bazaar`, "Max 32 printable ASCII characters."));
  else out.push(ok(S, `serviceName "${kept.serviceName}"`));
  if (!resource.tags?.length) out.push(warn(S, "no tags", "Up to 5 tags of max 32 ASCII chars help discovery search."));
  else {
    const dropped = resource.tags.filter((t) => !(kept.tags ?? []).includes(t));
    if (dropped.length) out.push(warn(S, `tags dropped by the Bazaar: ${dropped.join(", ")}`, "Max 5 tags, each max 32 printable ASCII chars."));
    if (kept.tags?.length) out.push(ok(S, `tags: ${kept.tags.join(", ")}`));
  }
  if (!resource.iconUrl) out.push(warn(S, "no iconUrl", "Catalogs show a generic icon. Use an absolute https URL to a square image."));
  else if (!kept.iconUrl) out.push(fail(S, `iconUrl "${resource.iconUrl}" is dropped by the Bazaar`, "Absolute https URL on a public host."));
  else out.push({ ...ok(S, `iconUrl ${kept.iconUrl}`), iconUrl: kept.iconUrl });
  return out;
}

export async function checkIcon(iconUrl) {
  const S = "Resource metadata";
  try {
    const { res } = await timedFetch(iconUrl, {}, 20_000);
    const type = res.headers.get("content-type") || "";
    if (!res.ok) return [fail(S, `icon answers ${res.status}`, "The catalog fetches and re-hosts the icon.")];
    if (!type.startsWith("image/")) return [warn(S, `icon is served as ${type || "no content-type"}`, "Serve it with an image/* content-type.")];
    return [ok(S, `icon loads (${type})`)];
  } catch (err) {
    return [fail(S, `icon could not be fetched: ${err.message}`)];
  }
}

export function checkBazaarExtension(challenge) {
  const S = "Bazaar discovery";
  if (challenge.error) return [];
  const ext = challenge.data.extensions?.bazaar;
  if (!ext) {
    return [fail(S, "no extensions.bazaar in the challenge", "Without it the CDP Bazaar does not index the route. Declare it with declareDiscoveryExtension() from @x402/extensions/bazaar.")];
  }
  const out = [];
  // The schema validator logs "unknown format" notices for date-time etc.; they say nothing about the listing
  const warnLog = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = validateDiscoveryExtension(ext);
  } finally {
    console.warn = warnLog;
  }
  // A warning, not a failure: the CDP Bazaar has indexed extensions this validator rejects
  if (!result.valid) out.push(warn(S, `the official validator (@x402/extensions) rejects the extension: ${(result.errors || []).join("; ")}`, "Facilitators may still index it, but other catalogs validate strictly. Check the info and schema fields."));
  else out.push(ok(S, "extension passes the official schema (@x402/extensions)"));
  const input = ext.info?.input ?? {};
  out.push(info(S, `input: ${input.type ?? "?"} ${input.method ?? ""}${input.pathParams ? `, path params ${Object.keys(input.pathParams).join(", ")}` : ""}${input.queryParams && Object.keys(input.queryParams).length ? `, query ${Object.keys(input.queryParams).join(", ")}` : ""}`));
  if (input.pathParams && !ext.routeTemplate) out.push(warn(S, "path parameters but no routeTemplate", "Without it every distinct URL is indexed as its own resource."));
  if (ext.routeTemplate) out.push(ok(S, `routeTemplate ${ext.routeTemplate}`));
  if (ext.info?.output?.example === undefined) out.push(warn(S, "no output example", "Catalogs show the example response; agents use it to decide whether to pay."));
  else out.push(ok(S, "output example present"));
  return out;
}

/** Registries such as x402scan probe every path in the OpenAPI document and expect a 402 from each. */
export async function checkOpenApi(url) {
  const S = "OpenAPI";
  const origin = new URL(url).origin;
  let doc = null, where = null;
  for (const p of ["/openapi.json", "/.well-known/openapi.json"]) {
    try {
      const { res } = await timedFetch(origin + p, {}, 30_000);
      if (res.ok) {
        doc = await res.json();
        where = p;
        break;
      }
    } catch {}
  }
  if (!doc) return [info(S, "no /openapi.json or /.well-known/openapi.json", "Optional, but x402scan and agents read it to learn routes and prices.")];
  const out = [ok(S, `found ${where} (OpenAPI ${doc.openapi ?? "?"})`)];
  if (!doc.info?.["x-guidance"]) out.push(info(S, "no info.x-guidance", "A short usage guide for agents; x402scan shows it."));
  const ops = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of ["get", "post", "put", "delete", "patch"]) if (item[method]) ops.push({ path, method, op: item[method] });
  }
  for (const { path, method, op } of ops.slice(0, 20)) {
    const params = op.parameters ?? [];
    let target = path, missing = false;
    const query = new URLSearchParams();
    for (const p of params) {
      const v = p.example ?? p.schema?.example ?? p.schema?.enum?.[0] ?? p.schema?.default;
      if (v === undefined) {
        if (p.required) missing = true;
        continue;
      }
      if (p.in === "path") target = target.replace(`{${p.name}}`, encodeURIComponent(v));
      if (p.in === "query") query.set(p.name, v);
    }
    const label = `${method.toUpperCase()} ${path}`;
    if (!op["x-payment-info"]) out.push(warn(S, `${label} has no x-payment-info`, "Registries read price and protocol from it; free routes do not belong in this document because probes expect 402 everywhere."));
    if (missing || /\{.+\}/.test(target)) {
      out.push(info(S, `${label}: skipped, a required parameter has no example`));
      continue;
    }
    try {
      const qs = query.toString();
      const { res } = await timedFetch(origin + target + (qs ? `?${qs}` : ""), { method: method.toUpperCase(), headers: method === "get" ? {} : { "content-type": "application/json" }, body: method === "get" ? undefined : "{}" }, 30_000);
      if (res.status === 402) out.push(ok(S, `${label} answers 402`));
      else out.push(warn(S, `${label} answers ${res.status}, not 402`, "Registries probe every listed path and expect a challenge. Remove free routes from the document or give parameters valid examples."));
    } catch (err) {
      out.push(warn(S, `${label} could not be probed: ${err.message}`));
    }
  }
  if (ops.length > 20) out.push(info(S, `${ops.length - 20} more operations not probed`));
  return out;
}

/** Looks the resource up in the CDP Bazaar (the index agentic.market and x402 discovery clients read). */
export async function checkBazaarIndex(url, challenge) {
  const S = "Bazaar index";
  if (challenge.error) return [];
  const payTo = challenge.data.accepts?.[0]?.payTo;
  const host = new URL(url).host;
  const routeTemplate = challenge.data.extensions?.bazaar?.routeTemplate;
  const wanted = (u) => {
    if (u === url.split("?")[0]) return true;
    if (!routeTemplate) return false;
    const re = new RegExp("^" + `${new URL(url).origin}${routeTemplate}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]+/g, "[^/]+") + "$");
    return u === `${new URL(url).origin}${routeTemplate}` || re.test(u);
  };
  try {
    const q = new URLSearchParams({ query: host });
    if (payTo) q.set("payTo", payTo);
    const { res } = await timedFetch(`${BAZAAR_SEARCH}?${q}`, {}, 30_000);
    if (!res.ok) return [warn(S, `Bazaar search answered ${res.status}`, "Try again later.")];
    const data = await res.json();
    const found = (data.resources ?? []).filter((r) => wanted(r.resource));
    if (!found.length) {
      return [warn(S, "not in the CDP Bazaar yet", "Resources are indexed after their first payment settled through a facilitator that catalogs Bazaar metadata (e.g. the CDP facilitator).")];
    }
    return found.map((r) => {
      const qy = r.quality ?? {};
      return ok(S, `indexed as ${r.resource}${r.serviceName ? ` ("${r.serviceName}")` : ""}, updated ${r.lastUpdated?.slice(0, 10) ?? "?"}, 30-day calls ${qy.l30DaysTotalCalls ?? 0} from ${qy.l30DaysUniquePayers ?? 0} payers`);
    });
  } catch (err) {
    return [warn(S, `Bazaar search failed: ${err.message}`)];
  }
}

export async function runChecks(url, { method = "GET", body, openapi = true, bazaar = true } = {}) {
  const results = [...checkHost(url)];
  let probe;
  try {
    const headers = { accept: "application/json", origin: "https://x402-listing-check.local" };
    if (body !== undefined) headers["content-type"] = "application/json";
    probe = await timedFetch(url, { method, headers, body });
  } catch (err) {
    const code = err.cause?.code;
    const why = code === "ENOTFOUND" ? "host not found (DNS)" : code === "ECONNREFUSED" ? "connection refused" : err.name === "TimeoutError" ? "no answer within 60 s" : (code || err.cause?.message || err.message);
    results.push(fail("402 challenge", `request failed: ${why}`, "Check the URL is the full public address of the paid route."));
    return results;
  }
  const bodyText = await probe.res.text();
  const challenge = parseChallenge(probe.res, bodyText);
  const challengeResults = checkChallenge({ url, res: probe.res, ms: probe.ms, challenge });
  results.push(...challengeResults.map(({ iconUrl, ...r }) => r));
  const icon = challengeResults.find((r) => r.iconUrl)?.iconUrl;
  if (icon) results.push(...(await checkIcon(icon)));
  results.push(...checkBazaarExtension(challenge));
  if (openapi) results.push(...(await checkOpenApi(url)));
  if (bazaar) results.push(...(await checkBazaarIndex(url, challenge)));
  return results;
}
