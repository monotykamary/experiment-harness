/**
 * Experiment Harness — HTTP server holding one persistent Session.
 *
 * Endpoints (bind 127.0.0.1:9877 by default; override with $EXPERIMENT_HARNESS_PORT):
 *   POST /eval     body = raw JS to evaluate. Top-level await supported.
 *                  Single expression auto-returns.
 *                  Response: raw result content (no envelope) on 200, error on 500.
 *   GET  /health   {"ok":true,"uptime":<seconds>,"initialized":<bool>,"runs":<number>}
 *   POST /quit     graceful shutdown.
 *
 * State: `session` and any `globalThis.<name>` you set persist across requests.
 */

import { Session } from "./session/index.ts";

const session = new Session();
(globalThis as any).session = session;

const PORT = Number(process.env.EXPERIMENT_HARNESS_PORT ?? 9877);
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// JS evaluation helpers (same pattern as browser-harness-js)
// ---------------------------------------------------------------------------

function isExpression(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (/[;\n]/.test(trimmed)) return false;
  if (
    /^(let|const|var|if|for|while|do|switch|class|function|throw|try|return|import|export)\b/.test(
      trimmed,
    )
  )
    return false;
  return true;
}

function serialize(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(
      JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)),
    );
  } catch {
    return String(v);
  }
}

async function runSnippet(code: string): Promise<unknown> {
  const body = isExpression(code) ? `return (${code});` : code;
  const wrapped = `(async () => { ${body} })()`;
  return await (0, eval)(wrapped);
}

function renderResult(v: unknown): string {
  const s = serialize(v);
  if (s === undefined || s === null) return "";
  if (typeof s === "string") return s;
  if (Array.isArray(s) && s.length === 0) return "";
  if (typeof s === "object" && s !== null && Object.keys(s as object).length === 0)
    return "";
  return JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const TEXT = { "content-type": "text/plain; charset=utf-8" } as const;

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      const status = session.status();
      return Response.json({
        ok: true,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        initialized: status.initialized,
        runs: status.runs,
        loopStatus: status.loopStatus,
      });
    }

    if (req.method === "POST" && url.pathname === "/eval") {
      const code = await req.text();
      if (!code.trim()) {
        return new Response("empty body\n", { status: 400, headers: TEXT });
      }
      try {
        const result = await runSnippet(code);
        const body = renderResult(result);
        return new Response(body, { status: 200, headers: TEXT });
      } catch (e: any) {
        const msg = (e?.stack ?? e?.message ?? String(e)) + "\n";
        return new Response(msg, { status: 500, headers: TEXT });
      }
    }

    if (req.method === "POST" && url.pathname === "/quit") {
      setTimeout(() => {
        server.stop(true);
        process.exit(0);
      }, 50);
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(
  JSON.stringify({
    ok: true,
    ready: true,
    port: server.port,
    message: `Experiment Harness listening on http://127.0.0.1:${server.port}`,
  }),
);
