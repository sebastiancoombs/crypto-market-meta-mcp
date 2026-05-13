// Crypto market-data META over MT's 5 already-shipped price/market services.
// Pattern lifted from wallet-intel-meta-mcp + dex-router-best-quote-mcp.

const FEEDS = [
  {
    feed: "coinpaprika",
    url: "https://coinpaprika-mcp.mtree.workers.dev/v1/ticker",
    body: ({ symbol }) => ({ coin_id: paprikaIdFor(symbol) }),
    description: "Coinpaprika v1 ticker — live price, volume, market cap, % changes.",
    extractPrice: (data) => Number(data?.data?.quotes?.USD?.price) || null,
    extractMarketCap: (data) => Number(data?.data?.quotes?.USD?.market_cap) || null,
  },
  {
    feed: "coincap",
    url: "https://coincap-mcp.mtree.workers.dev/v1/asset",
    body: ({ symbol }) => ({ id: coincapIdFor(symbol) }),
    description: "CoinCap v3 asset — price, supply, market cap, 24h volume.",
    extractPrice: (data) => Number(data?.data?.priceUsd ?? data?.data?.data?.priceUsd) || null,
    extractMarketCap: (data) => Number(data?.data?.marketCapUsd ?? data?.data?.data?.marketCapUsd) || null,
  },
  {
    feed: "coinlore",
    url: "https://coinlore-mcp.mtree.workers.dev/v1/ticker",
    body: ({ symbol }) => ({ id: coinloreIdFor(symbol) }),
    description: "Coinlore ticker — price + market cap + supply.",
    extractPrice: (data) => Number(data?.data?.[0]?.price_usd ?? data?.data?.price_usd) || null,
    extractMarketCap: (data) => Number(data?.data?.[0]?.market_cap_usd ?? data?.data?.market_cap_usd) || null,
  },
  {
    feed: "cryptocompare",
    url: "https://cryptocompare-mcp.mtree.workers.dev/v1/price",
    body: ({ symbol }) => ({ fsym: String(symbol || "BTC").toUpperCase(), tsyms: "USD" }),
    description: "CryptoCompare min-api — single-symbol USD price.",
    extractPrice: (data) => Number(data?.data?.USD ?? data?.USD) || null,
    extractMarketCap: () => null,
  },
  {
    feed: "kraken",
    url: "https://kraken-mcp.mtree.workers.dev/v1/ticker",
    body: ({ symbol }) => ({ pair: krakenPairFor(symbol) }),
    description: "Kraken public ticker — last-trade price + bid/ask.",
    extractPrice: (data) => {
      const result = data?.data?.data ?? data?.data ?? {};
      const pairKey = result && typeof result === "object" && Object.keys(result).find((k) => Array.isArray(result[k]?.c));
      return pairKey ? Number(result[pairKey]?.c?.[0]) || null : null;
    },
    extractMarketCap: () => null,
  },
];

// Common symbol → feed-specific id maps. Kept compact; falls back to symbol/uppercase.
function paprikaIdFor(s) {
  const m = { BTC: "btc-bitcoin", ETH: "eth-ethereum", SOL: "sol-solana", USDC: "usdc-usd-coin", USDT: "usdt-tether", DAI: "dai-dai" };
  return m[String(s || "").toUpperCase()] || `${String(s || "").toLowerCase()}-${String(s || "").toLowerCase()}`;
}
function coincapIdFor(s) {
  const m = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", USDC: "usd-coin", USDT: "tether", DAI: "dai" };
  return m[String(s || "").toUpperCase()] || String(s || "").toLowerCase();
}
function coinloreIdFor(s) {
  const m = { BTC: "90", ETH: "80", SOL: "48543", USDC: "33285", USDT: "518", DAI: "45219" };
  return m[String(s || "").toUpperCase()] || "90";
}
function krakenPairFor(s) {
  const m = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", USDC: "USDCUSD", USDT: "USDTUSD", DAI: "DAIUSD" };
  return m[String(s || "").toUpperCase()] || `${String(s || "").toUpperCase()}USD`;
}

function isSymbol(s) {
  return typeof s === "string" && s.trim().length >= 2 && s.length < 20;
}

async function fetchFeed(feed, payload, timeoutMs, paymentHeader) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body, status, ok, errMsg;
  try {
    const r = await fetch(feed.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(paymentHeader ? { "x-payment": paymentHeader } : {}), "user-agent": "crypto-market-meta-mcp/0.1.0" },
      body: JSON.stringify(feed.body(payload)),
      signal: controller.signal,
    });
    status = r.status;
    const txt = await r.text();
    try { body = JSON.parse(txt); } catch { body = { raw: txt.slice(0, 4000) }; }
    ok = r.status >= 200 && r.status < 300;
  } catch (e) {
    status = 0;
    ok = false;
    errMsg = e?.name === "AbortError" ? `timeout_after_${timeoutMs}ms` : String(e?.message || e);
    body = { error: errMsg };
  } finally {
    clearTimeout(timer);
  }
  let price = null, marketCap = null;
  if (ok && body) {
    try { price = feed.extractPrice(body); } catch {}
    try { marketCap = feed.extractMarketCap(body); } catch {}
  }
  return {
    feed: feed.feed,
    source_url: feed.url,
    description: feed.description,
    status_code: status,
    ok,
    latency_ms: Date.now() - start,
    error: errMsg || null,
    price_usd: price,
    market_cap_usd: marketCap,
    raw: body,
  };
}

function consensusPrice(rows) {
  const prices = rows.filter((r) => r.ok && r.price_usd && Number.isFinite(Number(r.price_usd))).map((r) => Number(r.price_usd));
  if (prices.length === 0) return { median: null, mean: null, min: null, max: null, spread_pct: null, sources_used: 0 };
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const spread = max > 0 ? ((max - min) / max) * 100 : 0;
  return { median, mean, min, max, spread_pct: spread, sources_used: prices.length };
}

export async function buildCryptoConsensus({ symbol, timeoutMs, paymentHeader }) {
  if (!isSymbol(symbol)) {
    const e = new Error("`symbol` is required (e.g., BTC, ETH, SOL)");
    e.status = 400;
    throw e;
  }
  const t = Number(timeoutMs) || 8000;
  const payload = { symbol };
  const t0 = Date.now();
  const settled = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f, payload, t, paymentHeader)));
  const feeds = [];
  for (const r of settled) {
    if (r.status === "fulfilled") feeds.push(r.value);
    else feeds.push({ ok: false, error: String(r.reason?.message || r.reason), feed: "unknown", source_url: null });
  }
  const consensus = consensusPrice(feeds);
  return {
    service: "crypto-market-meta-mcp",
    version: "0.1.0",
    symbol: String(symbol).toUpperCase(),
    composed_feeds: FEEDS.length,
    ok_feeds: feeds.filter((r) => r.ok).length,
    failed_feeds: feeds.filter((r) => !r.ok).length,
    total_latency_ms: Date.now() - t0,
    timeout_ms_per_feed: t,
    consensus,
    feeds,
    note:
      "v0.1 fan-out captures upstream 402 envelopes (per-feed source_url + ok=false). Settle X-PAYMENT against each source_url for live data; v0.2 forwards caller X-PAYMENT to upstream MT services when present.",
  };
}

export async function buildCryptoConsensusSummary(opts) {
  const data = await buildCryptoConsensus(opts);
  const lines = [];
  lines.push(
    `Cross-feed crypto consensus for ${data.symbol} — fanned to ${data.composed_feeds} feeds (coinpaprika, coincap, coinlore, cryptocompare, kraken).`
  );
  if (data.ok_feeds > 0 && data.consensus.median) {
    lines.push(
      `Median price across ${data.consensus.sources_used} sources: $${Number(data.consensus.median).toFixed(6)} (mean $${Number(data.consensus.mean).toFixed(6)}, spread ${Number(data.consensus.spread_pct).toFixed(2)}%, range $${Number(data.consensus.min).toFixed(6)}–$${Number(data.consensus.max).toFixed(6)}).`
    );
  } else {
    lines.push("No usable price — most upstream feeds returned 402. Settle X-PAYMENT per source_url for live data.");
  }
  const half = Math.ceil(lines.length / 2);
  return {
    service: "crypto-market-meta-mcp",
    version: "0.1.0",
    symbol: data.symbol,
    summary: [lines.slice(0, half).join(" "), lines.slice(half).join(" ")].filter(Boolean).join("\n\n"),
    consensus: data.consensus,
    composed_feeds: data.composed_feeds,
    ok_feeds: data.ok_feeds,
    failed_feeds: data.failed_feeds,
    total_latency_ms: data.total_latency_ms,
  };
}
