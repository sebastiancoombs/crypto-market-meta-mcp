// Minimal MCP Streamable HTTP transport (JSON-RPC 2.0 over POST /mcp).

const PROTOCOL_VERSION = "2025-06-18";
const NETWORK = "base";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const TOOLS = [
  {
    name: "wallet_dossier",
    description:
      "Composite EVM wallet dossier — fan-out to 7 wallet-intelligence services in parallel: labels (ENS/OFAC/mixer registries), portfolio_risk (Aave/Compound/UniV3/holdings/GoPlus), defi_health (Morpho/Aerodrome/Pendle/Lido), mev_exposure (sandwich score), approvals_risk (ERC-20/721/1155 unlimited+malicious+unverified), cex_flows (per-CEX flows), funding_trace (multi-hop predecessor walk). Per-axis source_url + ok + latency_ms; fail-soft. Costs $0.75 USDC on Base via x402.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["address"],
      properties: {
        address: { type: "string", description: "EVM address (0x… 20 bytes)" },
        chain: { type: "string", description: "Single-chain axes: ethereum/base/arbitrum/optimism/polygon" },
        chains: { type: "array", items: { type: "string" }, description: "Multi-chain axes default" },
      },
    },
    _route: "/v1/wallet/dossier",
    _price: "$0.75",
  },
  {
    name: "wallet_dossier_summary",
    description:
      "Plain-English 2-paragraph summary of an EVM wallet dossier — same 7-axis fan-out as wallet_dossier, condensed to one human-readable summary string + counts. Faster, lighter shape, ideal for triage and chat agents. Costs $0.50 USDC on Base via x402.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["address"],
      properties: {
        address: { type: "string", description: "EVM address (0x… 20 bytes)" },
        chain: { type: "string", description: "Single-chain axes default" },
        chains: { type: "array", items: { type: "string" }, description: "Multi-chain axes default" },
      },
    },
    _route: "/v1/wallet/dossier_summary",
    _price: "$0.50",
  },
];

function jsonrpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function jsonrpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}

function originFromRequest(c) {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

function priceToAtomicUsdc(priceStr) {
  const dollars = Number(String(priceStr).replace(/[^0-9.]/g, ""));
  return String(Math.round(dollars * 1_000_000));
}

function syntheticX402Envelope({ tool, originUrl, payTo }) {
  const resource = `${originUrl}${tool._route}`;
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        maxAmountRequired: priceToAtomicUsdc(tool._price),
        resource,
        description: tool.description,
        mimeType: "application/json",
        payTo: payTo || "0x1664530DC2A1CA350B1dbaD1Fc1F1a70c90fe4de",
        maxTimeoutSeconds: 60,
        asset: BASE_USDC,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
}

async function handleSingle(c, msg) {
  const { id, method, params } = msg || {};

  if (method === "initialize") {
    return jsonrpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "wallet-intel-meta-mcp",
        version: "0.1.0",
        title: "Wallet Intelligence Meta-Aggregator MCP (x402)",
      },
      instructions:
        "Pay-per-call MCP META-aggregator for EVM wallet intelligence. Composes 7 services in parallel into one dossier. Tools require x402 USDC payment on Base. tools/call returns a 402 envelope; settle X-PAYMENT and retry against the REST endpoint.",
    });
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }

  if (method === "tools/list") {
    const tools = TOOLS.map(({ name, description, inputSchema, _price }) => ({
      name,
      description,
      inputSchema,
      annotations: { x402_price: _price, x402_network: "base" },
    }));
    return jsonrpcResult(id, { tools });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) return jsonrpcError(id, -32602, `Unknown tool: ${toolName}`);

    const origin = originFromRequest(c);
    const payTo =
      (typeof process !== "undefined" && process.env?.PAY_TO_ADDRESS) || undefined;
    const envelope = syntheticX402Envelope({ tool, originUrl: origin, payTo });

    return jsonrpcResult(id, {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `Payment required: ${tool._price} USDC on Base via x402. ` +
            `Settle the x402 envelope below by signing X-PAYMENT, then POST your arguments to ${origin}${tool._route}. ` +
            `Repo: https://github.com/sebastiancoombs/wallet-intel-meta-mcp`,
        },
        { type: "text", text: JSON.stringify(envelope, null, 2) },
      ],
      structuredContent: {
        x402: envelope,
        retry_endpoint: `${origin}${tool._route}`,
        price: tool._price,
        network: NETWORK,
      },
    });
  }

  if (method === "ping") return jsonrpcResult(id, {});

  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

export async function mcpHandler(c) {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      400
    );
  }
  if (Array.isArray(body)) {
    const results = [];
    for (const msg of body) {
      const r = await handleSingle(c, msg);
      if (r) results.push(r);
    }
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
    serverInfo: { name: "wallet-intel-meta-mcp", version: "0.1.0" },
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      price: t._price,
    })),
    note: "POST JSON-RPC 2.0 to this URL (initialize, tools/list, tools/call).",
  });
}
