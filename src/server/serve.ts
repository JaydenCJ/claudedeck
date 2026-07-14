/**
 * Local dashboard server.
 *
 * A tiny HTTP server built on node:http — no framework, no middleware, and
 * bound to 127.0.0.1 by default so nothing is exposed beyond the machine.
 * Log data is re-read (with a small TTL cache) so the dashboard picks up new
 * sessions without a restart.
 *
 * Besides the read-only views, the edit endpoints back the dashboard's edit
 * buttons: toggling assets (skills/agents/commands), creating assets from
 * templates, editing asset file contents (GET/PUT /api/assets/content), and
 * toggling hooks. All writes stay inside the Claude home, and the server
 * rejects requests from other web origins: the Host header must name this
 * machine (DNS-rebinding guard), POSTs/PUTs must carry no Origin or a local
 * one (CSRF guard), and bodies must be `application/json` so browser "simple
 * requests" (text/plain, no CORS preflight) cannot reach the write handlers.
 */

import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { loadAllEntries } from "../parser/jsonl.js";
import { aggregate, totals } from "../engine/aggregate.js";
import { DISABLED_SUFFIX, inspectConfig } from "../config/inspect.js";
import {
  createAsset,
  readAssetContent,
  setAssetEnabled,
  setHookEnabled,
  writeAssetContent,
} from "../config/edit.js";
import type { AssetInfo, Dimension, LogEntry, PricingTable } from "../types.js";
import { DASHBOARD_HTML } from "./dashboardHtml.js";

const DIMENSIONS: Dimension[] = ["project", "date", "model", "subagent", "mcp"];
const ASSET_KINDS = new Set<AssetInfo["kind"]>(["skill", "agent", "command"]);
const CACHE_TTL_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;

/** Hostnames that always refer to this machine, regardless of the bound interface. */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Extract the hostname (sans port, brackets kept for IPv6) from a Host header. */
function hostnameOf(hostHeader: string): string {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return "";
  }
}

/**
 * DNS-rebinding defence: a page at attacker.example can point its DNS at
 * 127.0.0.1 and then talk to this server, but the browser still sends
 * `Host: attacker.example`. Only serve requests whose Host header names this
 * machine — a loopback name, the host we were asked to bind, or the actual
 * interface address the client connected to.
 */
function isAllowedHost(req: http.IncomingMessage, boundHost: string): boolean {
  const hostname = hostnameOf(req.headers.host ?? "");
  if (!hostname) return false;
  if (LOCAL_HOSTNAMES.has(hostname) || hostname === boundHost) return true;
  const local = req.socket.localAddress ?? "";
  const bare = hostname.replace(/^\[|\]$/g, "");
  return bare === local || `::ffff:${bare}` === local;
}

/**
 * CSRF defence for the write endpoints: browsers attach an Origin header to
 * every cross-site POST (including "simple" text/plain ones that skip CORS
 * preflight). Accept only requests with no Origin (curl, tests, non-browser
 * clients) or an Origin that is this dashboard itself.
 */
function isAllowedOrigin(origin: string | undefined, boundHost: string): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOCAL_HOSTNAMES.has(url.hostname) || url.hostname === boundHost;
}

/** An error with a specific HTTP status (anything else becomes a 500). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** True when `filePath` resolves inside `root` — edits must never escape the Claude home. */
function insideDir(root: string, filePath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(filePath);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/**
 * Guard for the content-editor endpoints: the path must stay inside the
 * Claude home and point at a markdown asset (enabled or `.disabled`).
 */
function assertEditablePath(claudeHome: string, filePath: string): void {
  if (!filePath) throw new HttpError(400, "filePath is required");
  if (!insideDir(claudeHome, filePath)) {
    throw new HttpError(400, "filePath must be inside the Claude config directory");
  }
  const baseName = filePath.endsWith(DISABLED_SUFFIX)
    ? filePath.slice(0, -DISABLED_SUFFIX.length)
    : filePath;
  if (!baseName.endsWith(".md")) {
    throw new HttpError(400, `filePath must be a markdown asset (.md or .md${DISABLED_SUFFIX})`);
  }
}

/** Map a missing asset file (ENOENT) to a 404 instead of a generic 500. */
function rethrowMissingAs404(err: unknown): never {
  if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
    throw new HttpError(404, "asset file not found");
  }
  throw err;
}

export interface ServeOptions {
  claudeHome: string;
  port?: number;
  host?: string;
  pricing?: PricingTable;
}

export function createDashboardServer(opts: ServeOptions): http.Server {
  const boundHost = opts.host ?? "127.0.0.1";
  let cache: { entries: LogEntry[]; loadedAt: number } | undefined;

  async function entries(): Promise<LogEntry[]> {
    if (!cache || Date.now() - cache.loadedAt > CACHE_TTL_MS) {
      cache = { entries: await loadAllEntries(opts.claudeHome), loadedAt: Date.now() };
    }
    return cache.entries;
  }

  function sinceFrom(url: URL): Date | undefined {
    const days = Number(url.searchParams.get("days"));
    if (!Number.isFinite(days) || days <= 0) return undefined;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  return http.createServer(async (req, res) => {
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    try {
      // Every request must name this machine in its Host header (DNS-rebinding guard).
      if (!isAllowedHost(req, boundHost)) {
        sendJson(403, { error: "forbidden: unexpected Host header" });
        return;
      }
      // Writes must additionally come from the dashboard itself (CSRF guard).
      if ((req.method === "POST" || req.method === "PUT") && !isAllowedOrigin(req.headers.origin, boundHost)) {
        sendJson(403, { error: "forbidden: cross-origin requests are not allowed" });
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }

      if (url.pathname === "/api/summary") {
        const t = totals(await entries(), { pricing: opts.pricing, since: sinceFrom(url) });
        sendJson(200, { ...t, dataDir: opts.claudeHome });
        return;
      }

      if (url.pathname === "/api/top") {
        const by = url.searchParams.get("by") as Dimension | null;
        if (!by || !DIMENSIONS.includes(by)) {
          sendJson(400, { error: `"by" must be one of: ${DIMENSIONS.join(", ")}` });
          return;
        }
        sendJson(200, aggregate(await entries(), by, { pricing: opts.pricing, since: sinceFrom(url) }));
        return;
      }

      if (url.pathname === "/api/config") {
        sendJson(200, await inspectConfig(opts.claudeHome, { projectDir: process.cwd() }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/assets/content") {
        const filePath = url.searchParams.get("filePath") ?? "";
        assertEditablePath(opts.claudeHome, filePath);
        const content = await readAssetContent(filePath).catch(rethrowMissingAs404);
        sendJson(200, { filePath, content });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/assets/content") {
        const body = await readJsonBody(req);
        const filePath = body.filePath;
        const content = body.content;
        if (typeof filePath !== "string" || typeof content !== "string") {
          sendJson(400, { error: "expected { filePath: string, content: string }" });
          return;
        }
        assertEditablePath(opts.claudeHome, filePath);
        await writeAssetContent(filePath, content).catch(rethrowMissingAs404);
        sendJson(200, { ok: true, filePath, bytes: Buffer.byteLength(content, "utf8") });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/assets/toggle") {
        const body = await readJsonBody(req);
        const filePath = body.filePath;
        const enabled = body.enabled;
        if (typeof filePath !== "string" || typeof enabled !== "boolean") {
          sendJson(400, { error: "expected { filePath: string, enabled: boolean }" });
          return;
        }
        if (!insideDir(opts.claudeHome, filePath)) {
          sendJson(400, { error: "filePath must be inside the Claude config directory" });
          return;
        }
        const baseName = filePath.endsWith(DISABLED_SUFFIX)
          ? filePath.slice(0, -DISABLED_SUFFIX.length)
          : filePath;
        if (!baseName.endsWith(".md")) {
          sendJson(400, { error: `filePath must be a markdown asset (.md or .md${DISABLED_SUFFIX})` });
          return;
        }
        const result = await setAssetEnabled(filePath, enabled);
        sendJson(200, { ok: true, filePath: result.filePath, enabled, changed: result.changed });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/assets/new") {
        const body = await readJsonBody(req);
        const kind = body.kind;
        const name = body.name;
        if (typeof kind !== "string" || !ASSET_KINDS.has(kind as AssetInfo["kind"]) || typeof name !== "string") {
          sendJson(400, { error: "expected { kind: skill|agent|command, name: string }" });
          return;
        }
        const filePath = await createAsset(opts.claudeHome, kind as AssetInfo["kind"], name);
        sendJson(200, { ok: true, filePath });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/hooks/toggle") {
        const body = await readJsonBody(req);
        const { source, event, matcher, command, enabled } = body as {
          source?: unknown; event?: unknown; matcher?: unknown; command?: unknown; enabled?: unknown;
        };
        if (typeof source !== "string" || typeof event !== "string" || typeof enabled !== "boolean") {
          sendJson(400, { error: "expected { source, event, enabled } (+ optional matcher, command)" });
          return;
        }
        const changed = await setHookEnabled(
          opts.claudeHome,
          {
            source,
            event,
            matcher: typeof matcher === "string" ? matcher : undefined,
            command: typeof command === "string" ? command : undefined,
          },
          enabled,
        );
        sendJson(200, { ok: true, enabled, changed });
        return;
      }

      sendJson(404, { error: "not found" });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Start the dashboard and resolve with the actual bound port. */
export function startDashboard(opts: ServeOptions): Promise<{ server: http.Server; port: number }> {
  const server = createDashboardServer(opts);
  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 7433, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 7433);
      resolve({ server, port });
    });
  });
}
