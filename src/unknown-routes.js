// Unknown-route capture (revealed-preference for agent demand).
//
// Mounted as a Hono `notFound` handler — fires only when no other route
// matched. Logs the path + UA + origin to the shared D1 `unknown_routes`
// table so MINE / PULSE can analyze "what agents are probing on our domain
// that we don't yet expose."
//
// Skipped paths: assets, bots-noise (favicon, robots, /etc/), preflight
// OPTIONS, anything obviously not API-shaped. Cuts log volume ~95%.

const SKIP_PATTERNS = [
  /^\/$/,
  /^\/favicon\.ico$/,
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/apple-touch-icon/,
  /^\/_next\//,
  /^\/static\//,
  /^\/\.env/,
  /^\/wp-/,
  /^\/admin\b/i,
  /^\/etc\/passwd/i,
  /^\/cgi-bin/i,
];

// Heuristic: agent-ish if UA contains any of these tokens. Not exhaustive —
// agents using stock fetch() show as `node`/`undici` and we capture them too.
const AGENT_UA_RE = /\b(claude|cursor|cline|langchain|langgraph|crewai|autogen|llamaindex|agent|gpt|llm|anthropic|openai|smithery|x402|model-context|mcp-client|goose|aider|codex)\b/i;
const GENERIC_UA_RE = /\b(node|undici|python-requests|axios|got|curl|httpie)\b/i;

function classifyUa(ua) {
  if (!ua) return { is_agent: 0, is_generic: 0 };
  if (AGENT_UA_RE.test(ua)) return { is_agent: 1, is_generic: 0 };
  if (GENERIC_UA_RE.test(ua)) return { is_agent: 0, is_generic: 1 };
  return { is_agent: 0, is_generic: 0 };
}

export function unknownRouteCapture({ service }) {
  return async (c) => {
    const path = c.req.path;
    const method = c.req.method;
    if (method === "OPTIONS") {
      return c.text("", 204);
    }
    for (const re of SKIP_PATTERNS) {
      if (re.test(path)) {
        return c.text("not_found", 404);
      }
    }
    const ua = c.req.header("user-agent") || "";
    const origin = c.req.header("origin") || c.req.header("referer") || "";
    const cfCountry = c.req.header("cf-ipcountry") || "";
    const reqId = c.req.header("cf-ray") || "";
    const { is_agent } = classifyUa(ua);

    const db = c.env?.PAID_CALLS_DB;
    if (db) {
      const ts = Math.floor(Date.now() / 1000);
      const iso = new Date(ts * 1000).toISOString();
      const insert = db
        .prepare(
          `INSERT INTO unknown_routes
             (ts, iso_ts, service, method, path, user_agent, is_agent_ua, origin, ip_country, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          ts,
          iso,
          service,
          method,
          path,
          ua.slice(0, 240),
          is_agent,
          origin.slice(0, 240),
          cfCountry.slice(0, 8),
          reqId.slice(0, 64)
        );
      const ec = c.executionCtx;
      if (ec?.waitUntil) {
        ec.waitUntil(
          insert.run().catch((err) =>
            console.warn(`[unknown-routes] insert failed`, err)
          )
        );
      } else {
        insert.run().catch((err) => console.warn(`[unknown-routes] insert failed`, err));
      }
    }

    return c.json(
      {
        error: "not_found",
        method,
        path,
        hint: "GET / for the service descriptor; /.well-known/agent-card.json for the AgentCard; /openapi.yaml for the OpenAPI spec.",
      },
      404
    );
  };
}

// Read endpoints (public — same posture as paid-calls admin).
export function mountUnknownRoutesAdmin(app, { route = "/v1/admin/unknown_routes" } = {}) {
  app.get(route, async (c) => {
    const db = c.env?.PAID_CALLS_DB;
    if (!db) return c.json({ error: "no_db_binding" }, 500);
    const sinceParam = c.req.query("since_unix");
    const limitParam = c.req.query("limit");
    const onlyAgents = c.req.query("agents") === "1";
    const limit = Math.max(1, Math.min(parseInt(limitParam ?? "500", 10) || 500, 5000));
    let sql = `SELECT ts, iso_ts, service, method, path, user_agent, is_agent_ua, origin, ip_country, request_id
                 FROM unknown_routes`;
    const conds = [];
    const binds = [];
    if (sinceParam) {
      const since = parseInt(sinceParam, 10);
      if (Number.isFinite(since)) {
        conds.push("ts >= ?");
        binds.push(since);
      }
    }
    if (onlyAgents) {
      conds.push("is_agent_ua = 1");
    }
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY ts DESC LIMIT ?";
    binds.push(limit);
    try {
      const stmt = binds.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...binds);
      const { results } = await stmt.all();
      return c.json({ ok: true, count: results.length, rows: results });
    } catch (err) {
      return c.json({ ok: false, error: String(err?.message || err) }, 500);
    }
  });

  app.get(`${route}/summary`, async (c) => {
    const db = c.env?.PAID_CALLS_DB;
    if (!db) return c.json({ error: "no_db_binding" }, 500);
    const since = Math.floor(Date.now() / 1000) - 86400 * 7;
    try {
      const { results } = await db
        .prepare(
          `SELECT service, method, path, is_agent_ua,
                  COUNT(*) AS hits,
                  MIN(ts) AS first_ts,
                  MAX(ts) AS last_ts,
                  COUNT(DISTINCT user_agent) AS distinct_uas,
                  COUNT(DISTINCT origin) AS distinct_origins
             FROM unknown_routes
            WHERE ts >= ?
            GROUP BY service, method, path, is_agent_ua
            ORDER BY hits DESC
            LIMIT 200`
        )
        .bind(since)
        .all();
      return c.json({ ok: true, since_unix: since, rows: results });
    } catch (err) {
      return c.json({ ok: false, error: String(err?.message || err) }, 500);
    }
  });
}
