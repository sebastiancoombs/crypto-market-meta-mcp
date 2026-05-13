import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { paidCallsCapture, mountPaidCallsAdmin } from "./paid-calls.js";
import { unknownRouteCapture, mountUnknownRoutesAdmin } from "./unknown-routes.js";
import { createFacilitatorConfig } from "@coinbase/x402";
import { buildCryptoConsensus, buildCryptoConsensusSummary } from "./meta.js";
import { mcpHandler, mcpInfoHandler } from "./mcp.js";

import agentCard from "./static/.well-known/agent-card.json" with { type: "json" };
import mcpManifest from "./static/.well-known/mcp.json" with { type: "json" };
import aiPlugin from "./static/.well-known/ai-plugin.json" with { type: "json" };
import openapiYaml from "./static/openapi.yaml";
import agentDiscoveryHtml from "./static/agent-discovery.html";

const PAY_TO = process.env.PAY_TO_ADDRESS;
const NETWORK = process.env.X402_NETWORK || "base";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL;
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 8000;

const FACILITATOR =
  CDP_API_KEY_ID && CDP_API_KEY_SECRET
    ? createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)
    : FACILITATOR_URL
    ? { url: FACILITATOR_URL }
    : undefined;

const SERVICE_SLUG = "crypto-market-meta-mcp";
const PRICE_BY_PATH = {
  "/v1/crypto/consensus": 100000,
  "/v1/crypto/consensus_summary": 50000,
};

const PAID_GET_PATHS = new Set([]);

const app = new Hono();

function serviceBaseUrl(c) {
  const proto = c.req.header("x-forwarded-proto") || "https";
  const host = c.req.header("host") || `${SERVICE_SLUG}.mtree.workers.dev`;
  return `${proto}://${host}`;
}

function endpointInfo(c, path) {
  const amount = PRICE_BY_PATH[path];
  if (!amount) return null;
  return {
    service: SERVICE_SLUG,
    endpoint: path,
    method: "POST",
    price: `$${(amount / 1_000_000).toFixed(3)}`,
    atomic_amount: amount,
    network: NETWORK,
    pay_to: PAY_TO || null,
    hint: "POST this path with an x402 payment. GET/HEAD are metadata checks and are intentionally unpaid.",
  };
}

// Agent compatibility layer — keep common discovery / availability checks from
// falling into the 404 telemetry bucket. Agents do not all know our exact
// filenames or slash policy, so be liberal on read-only metadata paths.
app.use(async (c, next) => {
  const method = c.req.method.toUpperCase();
  const path = c.req.path;
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

  if (method === "OPTIONS") return c.text("", 204);

  if (method === "GET" && ["/.well-known/x402", "/.well-known/x402.json"].includes(normalized)) {
    return c.json({
      service: SERVICE_SLUG,
      x402: true,
      network: NETWORK,
      pay_to: PAY_TO || null,
      endpoints: Object.fromEntries(
        Object.entries(PRICE_BY_PATH).map(([p, amount]) => [
          `POST ${p}`,
          { price: `$${(amount / 1_000_000).toFixed(3)}`, atomic_amount: amount, network: NETWORK },
        ])
      ),
      discovery: {
        service: serviceBaseUrl(c),
        agent_card: `${serviceBaseUrl(c)}/.well-known/agent-card.json`,
        mcp: `${serviceBaseUrl(c)}/.well-known/mcp.json`,
        openapi: `${serviceBaseUrl(c)}/openapi.yaml`,
      },
    });
  }

  if (method === "GET" && ["/openapi.json", "/swagger.json", "/v3/api-docs", "/api-docs", "/api/docs"].includes(normalized)) {
    return c.text(openapiYaml, 200, { "content-type": "application/yaml" });
  }


  if (method === "GET" && PAID_GET_PATHS.has(normalized) && path !== normalized) {
    const qs = new URL(c.req.url).search;
    return c.redirect(`${normalized}${qs}`, 308);
  }

  if ((method === "HEAD" || (method === "GET" && !PAID_GET_PATHS.has(normalized))) && PRICE_BY_PATH[normalized]) {
    const info = endpointInfo(c, normalized);
    if (method === "HEAD") {
      return c.body(null, 204, {
        "x-money-tree-service": SERVICE_SLUG,
        "x-money-tree-endpoint": normalized,
        "x-money-tree-price-usdc": info.price,
        "x-money-tree-network": NETWORK,
        "link": `<${serviceBaseUrl(c)}/openapi.yaml>; rel="service-desc"`,
      });
    }
    return c.json(info);
  }

  return next();
});


app.get("/healthz", (c) =>
  c.json({ ok: true, service: "crypto-market-meta-mcp", composed_feeds: 5, upstream_timeout_ms: UPSTREAM_TIMEOUT_MS })
);

app.get("/.well-known/agent-card.json", (c) => c.json(agentCard));
app.get("/.well-known/mcp.json", (c) => c.json(mcpManifest));
app.get("/.well-known/ai-plugin.json", (c) => c.json(aiPlugin));
app.get("/openapi.yaml", (c) => c.text(openapiYaml, 200, { "content-type": "application/yaml" }));
app.get("/agent-discovery", (c) => c.html(agentDiscoveryHtml));

app.get("/mcp", mcpInfoHandler);
app.post("/mcp", mcpHandler);

app.get("/", (c) =>
  c.json({
    service: "crypto-market-meta-mcp",
    version: "0.1.0",
    description:
      "x402 META-aggregator: composes 5 already-shipped MT services (coinpaprika + coincap + coinlore + cryptocompare + kraken) in parallel into a single cross-feed consensus price (median + mean + spread) per symbol. Single billable hit per price-discovery query instead of N. No signup, no API key — pay USDC on Base.",
    composed_feeds: {
      coinpaprika: "Coinpaprika v1 ticker — live price + market cap + 24h volume + % changes.",
      coincap: "CoinCap v3 asset — price + supply + market cap.",
      coinlore: "Coinlore ticker — price + market cap + supply.",
      cryptocompare: "CryptoCompare min-api — single-symbol USD price.",
      kraken: "Kraken public ticker — last-trade + bid/ask CEX reference.",
    },
    endpoints: {
      "POST /v1/crypto/consensus": { price: "$0.10", network: NETWORK, feeds: 5 },
      "POST /v1/crypto/consensus_summary": { price: "$0.05", network: NETWORK, feeds: 5 },
    },
    pay_to: PAY_TO || null,
    repo: "https://github.com/sebastiancoombs/crypto-market-meta-mcp",
  })
);

if (PAY_TO) {
  app.use(paidCallsCapture({ service: SERVICE_SLUG, priceByPath: PRICE_BY_PATH }));
  app.use(
    paymentMiddleware(
      PAY_TO,
      {
        "POST /v1/crypto/consensus": {
          price: "$0.10",
          network: NETWORK,
          config: {
            description:
              "Cross-feed consensus price — fan-out to 5 feeds (coinpaprika, coincap, coinlore, cryptocompare, kraken) in parallel and return per-feed {price_usd, market_cap_usd, source_url, ok, latency_ms} + consensus {median, mean, min, max, spread_pct}. Fail-soft per feed.",
            discoverable: true,
            inputSchema: {
              bodyType: "json",
              bodyFields: {
                symbol: { type: "string", description: "Crypto ticker symbol (e.g., BTC, ETH, SOL, USDC)", example: "BTC" },
              },
            },
            outputSchema: {
              example: {
                service: "crypto-market-meta-mcp",
                symbol: "BTC",
                composed_feeds: 5,
                ok_feeds: 5,
                consensus: { median: 67500.5, mean: 67510.2, min: 67480.0, max: 67550.0, spread_pct: 0.10, sources_used: 5 },
                feeds: [{ feed: "coinpaprika", price_usd: 67500.5, ok: true }],
              },
            },
          },
        },
        "POST /v1/crypto/consensus_summary": {
          price: "$0.05",
          network: NETWORK,
          config: {
            description: "Plain-English summary of a cross-feed consensus price (median, mean, spread, sources). Same fan-out, lighter shape.",
            discoverable: true,
            inputSchema: {
              bodyType: "json",
              bodyFields: { symbol: { type: "string", description: "Crypto ticker symbol", example: "BTC" } },
            },
            outputSchema: {
              example: {
                service: "crypto-market-meta-mcp",
                symbol: "BTC",
                summary: "Cross-feed crypto consensus for BTC — fanned to 5 feeds…\n\nMedian price across 5 sources: $67500.500000 …",
                consensus: { median: 67500.5, sources_used: 5 },
              },
            },
          },
        },
      },
      FACILITATOR
    )
  );

  console.log(
    `[startup] facilitator=${
      CDP_API_KEY_ID && CDP_API_KEY_SECRET ? "coinbase-cdp" : FACILITATOR_URL || "x402.org-default"
    } upstream_timeout_ms=${UPSTREAM_TIMEOUT_MS}`
  );
} else {
  console.warn("[startup] PAY_TO_ADDRESS not set — running in UNPAID mode.");
}

app.post("/v1/crypto/consensus", async (c) => {
  let body;
  try { body = await c.req.json(); } catch { body = {}; }
  const { symbol } = body || {};
  try {
    const out = await buildCryptoConsensus({ symbol, timeoutMs: UPSTREAM_TIMEOUT_MS, paymentHeader: c.req.header("x-payment") });
    return c.json(out);
  } catch (e) {
    return c.json({ error: "consensus_failed", message: String(e.message || e) }, e.status || 500);
  }
});

app.post("/v1/crypto/consensus_summary", async (c) => {
  let body;
  try { body = await c.req.json(); } catch { body = {}; }
  const { symbol } = body || {};
  try {
    const out = await buildCryptoConsensusSummary({ symbol, timeoutMs: UPSTREAM_TIMEOUT_MS, paymentHeader: c.req.header("x-payment") });
    return c.json(out);
  } catch (e) {
    return c.json({ error: "consensus_summary_failed", message: String(e.message || e) }, e.status || 500);
  }
});

mountPaidCallsAdmin(app, { service: SERVICE_SLUG });
mountUnknownRoutesAdmin(app);

app.notFound(unknownRouteCapture({ service: SERVICE_SLUG }));

export { app };
