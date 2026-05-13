// Minimal MCP Streamable HTTP transport (JSON-RPC 2.0 over POST /mcp).

const PROTOCOL_VERSION = "2025-06-18";
const NETWORK = "base";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const TOOLS = [
  {
    name: "crypto_consensus",
    description:
      "Cross-feed crypto consensus price: fan-out to 5 feeds (coinpaprika, coincap, coinlore, cryptocompare, kraken) and return median/mean/spread + per-feed {price_usd, market_cap_usd, source_url, ok, latency_ms}. $0.10/call USDC on Base via x402.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["symbol"],
      properties: { symbol: { type: "string", description: "Crypto ticker symbol (e.g., BTC, ETH, SOL, USDC)" } },
    },
    _route: "/v1/crypto/consensus",
    _price: "$0.10",
  },
  {
    name: "crypto_consensus_summary",
    description: "Plain-English summary of cross-feed consensus price. Same fan-out, lighter shape. $0.05/call USDC on Base via x402.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["symbol"],
      properties: { symbol: { type: "string", description: "Crypto ticker symbol" } },
    },
    _route: "/v1/crypto/consensus_summary",
    _price: "$0.05",
  },
];

function jsonrpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function jsonrpcError(id, code, message, data) {
  const err = { code, message }; if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}
function originFromRequest(c) { const url = new URL(c.req.url); return `${url.protocol}//${url.host}`; }
function priceToAtomicUsdc(s) { return String(Math.round(Number(String(s).replace(/[^0-9.]/g, "")) * 1_000_000)); }
function syntheticX402Envelope({ tool, originUrl, payTo }) {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      maxAmountRequired: priceToAtomicUsdc(tool._price),
      resource: `${originUrl}${tool._route}`,
      description: tool.description,
      mimeType: "application/json",
      payTo: payTo || "0x1664530DC2A1CA350B1dbaD1Fc1F1a70c90fe4de",
      maxTimeoutSeconds: 60,
      asset: BASE_USDC,
      extra: { name: "USD Coin", version: "2" },
    }],
  };
}

async function handleSingle(c, msg) {
  const { id, method, params } = msg || {};
  if (method === "initialize") {
    return jsonrpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "crypto-market-meta-mcp", version: "0.1.0", title: "Crypto Market META MCP (x402)" },
      instructions:
        "Pay-per-call MCP META-aggregator for cross-feed crypto consensus pricing. Composes 5 feeds in parallel. Tools require x402 USDC payment on Base. tools/call returns a 402 envelope; settle X-PAYMENT and retry against the REST endpoint.",
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "tools/list") {
    const tools = TOOLS.map(({ name, description, inputSchema, _price }) => ({
      name, description, inputSchema, annotations: { x402_price: _price, x402_network: "base" },
    }));
    return jsonrpcResult(id, { tools });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return jsonrpcError(id, -32602, `Unknown tool: ${params?.name}`);
    const origin = originFromRequest(c);
    const payTo = (typeof process !== "undefined" && process.env?.PAY_TO_ADDRESS) || undefined;
    const envelope = syntheticX402Envelope({ tool, originUrl: origin, payTo });
    return jsonrpcResult(id, {
      isError: true,
      content: [
        { type: "text", text: `Payment required: ${tool._price} USDC on Base via x402. Settle X-PAYMENT and POST to ${origin}${tool._route}. Repo: https://github.com/sebastiancoombs/crypto-market-meta-mcp` },
        { type: "text", text: JSON.stringify(envelope, null, 2) },
      ],
      structuredContent: { x402: envelope, retry_endpoint: `${origin}${tool._route}`, price: tool._price, network: NETWORK },
    });
  }
  if (method === "ping") return jsonrpcResult(id, {});
  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

export async function mcpHandler(c) {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (Array.isArray(body)) {
    const results = [];
    for (const msg of body) { const r = await handleSingle(c, msg); if (r) results.push(r); }
    return c.json(results);
  }
  const r = await handleSingle(c, body);
  if (r === null) return c.body(null, 204);
  return c.json(r);
}

export function mcpInfoHandler(c) {
  return c.json({
    transport: "streamable-http",
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: "crypto-market-meta-mcp", version: "0.1.0" },
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, price: t._price })),
    note: "POST JSON-RPC 2.0 to this URL (initialize, tools/list, tools/call).",
  });
}
