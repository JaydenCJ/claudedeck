import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { startDashboard } from "../src/server/serve.js";

/**
 * Issue a request with arbitrary headers. `fetch` refuses to set forbidden
 * headers like Host and Origin, which is exactly what an attacker's browser
 * *does* send — so the hardening tests need to go through node:http.
 */
function raw(
  base: string,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const req = http.request(
      { hostname, port, method: options.method ?? "GET", path: options.path ?? "/", headers: options.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-home");

let server: http.Server;
let base: string;

beforeAll(async () => {
  const started = await startDashboard({ claudeHome: FIXTURES, port: 0 });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

afterAll(() => {
  server.close();
});

describe("dashboard server", () => {
  it("serves the self-contained dashboard page", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("claudedeck");
    // Zero-upload promise: no external scripts, styles or fonts.
    expect(html).not.toMatch(/src\s*=\s*["']https?:\/\//);
    expect(html).not.toMatch(/href\s*=\s*["']https?:\/\//);
  });

  it("serves /api/summary with totals", async () => {
    const res = await fetch(base + "/api/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.costUsd).toBeCloseTo(0.1545, 10);
    expect(body.sessions).toBe(2);
    expect(body.dataDir).toBe(FIXTURES);
  });

  it("serves /api/top for every dimension", async () => {
    for (const by of ["project", "date", "model", "subagent", "mcp"]) {
      const res = await fetch(`${base}/api/top?by=${by}`);
      expect(res.status).toBe(200);
      const rows = await res.json();
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown dimensions with 400", async () => {
    const res = await fetch(base + "/api/top?by=nope");
    expect(res.status).toBe(400);
  });

  it("filters by ?days=N", async () => {
    // Fixture data is from 2026-07 — a 1-day window from "now" excludes it all.
    const res = await fetch(base + "/api/summary?days=1");
    const body = await res.json();
    expect(body.costUsd).toBe(0);
  });

  it("serves /api/config with hooks and assets", async () => {
    const res = await fetch(base + "/api/config");
    const cfg = await res.json();
    expect(cfg.agents.map((a: { name: string }) => a.name)).toContain("code-reviewer");
    expect(cfg.hooks.length).toBe(3);
  });

  it("returns 404 JSON for unknown paths", async () => {
    const res = await fetch(base + "/nope");
    expect(res.status).toBe(404);
  });

  it("rejects requests with a foreign Host header (DNS-rebinding guard)", async () => {
    const res = await raw(base, { path: "/api/summary", headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  it("accepts loopback Host headers with or without a port", async () => {
    for (const host of ["localhost", "127.0.0.1:9999", "localhost:1234"]) {
      const res = await raw(base, { path: "/api/summary", headers: { host } });
      expect(res.status).toBe(200);
    }
  });
});

describe("dashboard edit endpoints", () => {
  let editServer: http.Server;
  let editBase: string;
  let home: string;

  beforeAll(async () => {
    // Copy the fixture home so POSTs never mutate the shared fixtures.
    home = await fs.mkdtemp(path.join(os.tmpdir(), "claudedeck-serve-edit-"));
    await fs.cp(FIXTURES, home, { recursive: true });
    const started = await startDashboard({ claudeHome: home, port: 0 });
    editServer = started.server;
    editBase = `http://127.0.0.1:${started.port}`;
  });

  afterAll(() => {
    editServer.close();
  });

  const post = (p: string, body: unknown) =>
    fetch(editBase + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("toggles an asset off and on via POST /api/assets/toggle", async () => {
    const skillPath = path.join(home, "skills", "changelog", "SKILL.md");
    let res = await post("/api/assets/toggle", { filePath: skillPath, enabled: false });
    expect(res.status).toBe(200);
    expect((await res.json()).filePath).toBe(skillPath + ".disabled");

    const cfg = await (await fetch(editBase + "/api/config")).json();
    expect(cfg.skills[0].enabled).toBe(false);

    res = await post("/api/assets/toggle", { filePath: skillPath + ".disabled", enabled: true });
    expect(res.status).toBe(200);
    const cfgAfter = await (await fetch(editBase + "/api/config")).json();
    expect(cfgAfter.skills[0].enabled).toBe(true);
  });

  it("rejects asset paths outside the Claude home", async () => {
    const res = await post("/api/assets/toggle", { filePath: "/etc/passwd", enabled: false });
    expect(res.status).toBe(400);
  });

  it("rejects toggling non-markdown files inside the Claude home", async () => {
    const settings = path.join(home, "settings.json");
    const res = await post("/api/assets/toggle", { filePath: settings, enabled: false });
    expect(res.status).toBe(400);
    // settings.json is still there under its real name.
    await expect(fs.stat(settings)).resolves.toBeDefined();
  });

  it("rejects cross-origin POSTs (CSRF guard)", async () => {
    const skillPath = path.join(home, "skills", "changelog", "SKILL.md");
    const res = await raw(editBase, {
      method: "POST",
      path: "/api/assets/toggle",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ filePath: skillPath, enabled: false }),
    });
    expect(res.status).toBe(403);
    await expect(fs.stat(skillPath)).resolves.toBeDefined();
  });

  it("accepts same-origin POSTs (the dashboard's own fetches)", async () => {
    const skillPath = path.join(home, "skills", "changelog", "SKILL.md");
    const off = await raw(editBase, {
      method: "POST",
      path: "/api/assets/toggle",
      headers: { "content-type": "application/json", origin: editBase },
      body: JSON.stringify({ filePath: skillPath, enabled: false }),
    });
    expect(off.status).toBe(200);
    const on = await raw(editBase, {
      method: "POST",
      path: "/api/assets/toggle",
      headers: { "content-type": "application/json", origin: editBase },
      body: JSON.stringify({ filePath: skillPath + ".disabled", enabled: true }),
    });
    expect(on.status).toBe(200);
  });

  it("rejects non-JSON content types (blocks preflight-free text/plain posts)", async () => {
    const skillPath = path.join(home, "skills", "changelog", "SKILL.md");
    const res = await fetch(editBase + "/api/assets/toggle", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ filePath: skillPath, enabled: false }),
    });
    expect(res.status).toBe(415);
    await expect(fs.stat(skillPath)).resolves.toBeDefined();
  });

  it("creates a new asset via POST /api/assets/new", async () => {
    const res = await post("/api/assets/new", { kind: "command", name: "release" });
    expect(res.status).toBe(200);
    const created = await fs.readFile(path.join(home, "commands", "release.md"), "utf8");
    expect(created).toContain("/release");
  });

  it("rejects invalid asset kinds and names", async () => {
    expect((await post("/api/assets/new", { kind: "virus", name: "x" })).status).toBe(400);
    const evil = await post("/api/assets/new", { kind: "command", name: "../evil" });
    expect(evil.status).toBeGreaterThanOrEqual(400);
    await expect(fs.stat(path.join(path.dirname(home), "evil.md"))).rejects.toThrow();
  });

  it("reads and writes asset contents via GET/PUT /api/assets/content", async () => {
    const skillPath = path.join(home, "skills", "changelog", "SKILL.md");
    let res = await fetch(editBase + "/api/assets/content?filePath=" + encodeURIComponent(skillPath));
    expect(res.status).toBe(200);
    const before = await res.json();
    expect(before.filePath).toBe(skillPath);
    expect(before.content).toContain("changelog");

    const updated = before.content + "\nEdited from the dashboard.\n";
    res = await fetch(editBase + "/api/assets/content", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: skillPath, content: updated }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(await fs.readFile(skillPath, "utf8")).toBe(updated);
  });

  it("rejects content reads/writes outside the Claude home or on non-markdown files", async () => {
    const outside = await fetch(editBase + "/api/assets/content?filePath=" + encodeURIComponent("/etc/passwd"));
    expect(outside.status).toBe(400);

    const settings = path.join(home, "settings.json");
    const nonMd = await fetch(editBase + "/api/assets/content?filePath=" + encodeURIComponent(settings));
    expect(nonMd.status).toBe(400);

    const write = await fetch(editBase + "/api/assets/content", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: settings, content: "{}" }),
    });
    expect(write.status).toBe(400);
    // settings.json is untouched.
    expect(JSON.parse(await fs.readFile(settings, "utf8"))).toBeTypeOf("object");
  });

  it("returns 404 for missing assets and never creates files via PUT", async () => {
    const ghost = path.join(home, "skills", "ghost", "SKILL.md");
    const read = await fetch(editBase + "/api/assets/content?filePath=" + encodeURIComponent(ghost));
    expect(read.status).toBe(404);
    const write = await fetch(editBase + "/api/assets/content", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: ghost, content: "boo" }),
    });
    expect(write.status).toBe(404);
    await expect(fs.stat(ghost)).rejects.toThrow();
  });

  it("rejects cross-origin PUTs to the content editor (CSRF guard)", async () => {
    const skillPath = path.join(home, "skills", "changelog", "SKILL.md");
    const before = await fs.readFile(skillPath, "utf8");
    const res = await raw(editBase, {
      method: "PUT",
      path: "/api/assets/content",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ filePath: skillPath, content: "pwned" }),
    });
    expect(res.status).toBe(403);
    expect(await fs.readFile(skillPath, "utf8")).toBe(before);
  });

  it("rejects malformed content payloads with 400", async () => {
    const res = await fetch(editBase + "/api/assets/content", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: 42, content: null }),
    });
    expect(res.status).toBe(400);
  });

  it("reports no-op toggles via changed: false", async () => {
    const agentPath = path.join(home, "agents", "code-reviewer.md");
    const res = await post("/api/assets/toggle", { filePath: agentPath, enabled: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(false);
    expect(body.filePath).toBe(agentPath);
  });

  it("toggles a hook via POST /api/hooks/toggle", async () => {
    const res = await post("/api/hooks/toggle", {
      source: "settings.local.json",
      event: "Stop",
      command: "notify-send 'Claude finished'",
      enabled: false,
    });
    expect(res.status).toBe(200);
    const cfg = await (await fetch(editBase + "/api/config")).json();
    const stop = cfg.hooks.find((h: { event: string }) => h.event === "Stop");
    expect(stop.enabled).toBe(false);
    const settings = JSON.parse(await fs.readFile(path.join(home, "settings.local.json"), "utf8"));
    expect(settings.disabledHooks.Stop).toBeDefined();
  });
});
