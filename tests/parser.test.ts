import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeProjectDirName,
  loadAllEntries,
  mcpServerOf,
  parseSessionFile,
  UNKNOWN_SUBAGENT,
  parseSessionContent,
} from "../src/parser/jsonl.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-home");
const SESSION_A = path.join(
  FIXTURES,
  "projects",
  "-home-dev-webapp",
  "11111111-aaaa-bbbb-cccc-000000000001.jsonl",
);

describe("mcpServerOf", () => {
  it("extracts the server name from MCP tool names", () => {
    expect(mcpServerOf("mcp__github__list_issues")).toBe("github");
    expect(mcpServerOf("mcp__claude-code-remote__send_message")).toBe("claude-code-remote");
  });

  it("returns undefined for built-in tools", () => {
    expect(mcpServerOf("Bash")).toBeUndefined();
    expect(mcpServerOf("Task")).toBeUndefined();
  });
});

describe("decodeProjectDirName", () => {
  it("decodes dash-encoded absolute paths", () => {
    expect(decodeProjectDirName("-home-dev-webapp")).toBe("/home/dev/webapp");
  });
  it("leaves plain names alone", () => {
    expect(decodeProjectDirName("myproject")).toBe("myproject");
  });
});

describe("parseSessionFile", () => {
  it("parses user and assistant entries, skipping summaries and malformed lines", async () => {
    const entries = await parseSessionFile(SESSION_A);
    // 7 valid user/assistant lines; the summary line and broken line are dropped.
    expect(entries).toHaveLength(7);
    expect(entries.every((e) => e.sessionId === "11111111-aaaa-bbbb-cccc-000000000001")).toBe(true);
    expect(entries[0].role).toBe("user");
    expect(entries[0].project).toBe("/home/dev/webapp");
  });

  it("extracts model, usage and timestamps from assistant turns", async () => {
    const entries = await parseSessionFile(SESSION_A);
    const a1 = entries.find((e) => e.uuid === "a1")!;
    expect(a1.model).toBe("claude-opus-4-8");
    expect(a1.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 2000,
      cacheReadTokens: 10000,
    });
    expect(a1.timestamp.toISOString()).toBe("2026-07-01T10:00:12.000Z");
  });

  it("extracts tool uses with MCP server attribution", async () => {
    const entries = await parseSessionFile(SESSION_A);
    const a2 = entries.find((e) => e.uuid === "a2")!;
    expect(a2.toolUses).toHaveLength(2);
    expect(a2.toolUses.map((t) => t.mcpServer)).toEqual(["github", "github"]);
    const a3 = entries.find((e) => e.uuid === "a3")!;
    expect(new Set(a3.toolUses.map((t) => t.mcpServer))).toEqual(new Set(["github", "slack"]));
  });

  it("resolves sidechain entries to the spawning subagent type", async () => {
    const entries = await parseSessionFile(SESSION_A);
    const sidechain = entries.filter((e) => e.isSidechain);
    expect(sidechain).toHaveLength(2);
    expect(sidechain.every((e) => e.subagentType === "code-reviewer")).toBe(true);
    const main = entries.filter((e) => !e.isSidechain);
    expect(main.every((e) => e.subagentType === undefined)).toBe(true);
  });

  it("marks unmatched sidechains as unknown", () => {
    const content = [
      JSON.stringify({
        type: "user",
        uuid: "x1",
        parentUuid: null,
        isSidechain: true,
        timestamp: "2026-07-01T00:00:00Z",
        message: { role: "user", content: "orphan sidechain prompt" },
      }),
    ].join("\n");
    const entries = parseSessionContent(content, { project: "p", sessionId: "s" });
    expect(entries[0].subagentType).toBe(UNKNOWN_SUBAGENT);
  });
});

describe("duplicate assistant lines (same message.id + requestId)", () => {
  const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const line = (extra: Record<string, unknown>) =>
    JSON.stringify({
      type: "assistant",
      parentUuid: null,
      timestamp: "2026-07-01T10:00:00Z",
      requestId: "req_1",
      ...extra,
    });

  it("counts a multi-line turn once, merging tool_use blocks from continuation lines", () => {
    const content = [
      line({
        uuid: "d1",
        message: { id: "msg_1", role: "assistant", model: "claude-opus-4-8", usage, content: [{ type: "text", text: "hi" }] },
      }),
      // Streaming continuation: same message.id + requestId, same usage, new tool_use block.
      line({
        uuid: "d2",
        message: { id: "msg_1", role: "assistant", model: "claude-opus-4-8", usage, content: [{ type: "tool_use", name: "mcp__github__list_issues", input: {} }] },
      }),
    ].join("\n");
    const entries = parseSessionContent(content, { project: "p", sessionId: "s" });
    expect(entries).toHaveLength(1);
    expect(entries[0].usage?.inputTokens).toBe(100); // not 200
    expect(entries[0].toolUses.map((t) => t.name)).toEqual(["mcp__github__list_issues"]);
  });

  it("does not deduplicate distinct turns or lines without a message.id", () => {
    const content = [
      line({ uuid: "d1", message: { id: "msg_1", role: "assistant", model: "claude-opus-4-8", usage } }),
      line({ uuid: "d2", message: { id: "msg_2", role: "assistant", model: "claude-opus-4-8", usage } }),
      line({ uuid: "d3", message: { role: "assistant", model: "claude-opus-4-8", usage } }),
      line({ uuid: "d3", message: { role: "assistant", model: "claude-opus-4-8", usage } }),
    ].join("\n");
    const entries = parseSessionContent(content, { project: "p", sessionId: "s" });
    expect(entries).toHaveLength(4); // id-less lines are never treated as duplicates
  });

  it("skips turns already seen in another session file (continued sessions)", async () => {
    const os = await import("node:os");
    const { promises: fs } = await import("node:fs");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claudedeck-dedupe-"));
    const projDir = path.join(dir, "projects", "-home-dev-app");
    await fs.mkdir(projDir, { recursive: true });
    const original = line({
      uuid: "d1",
      sessionId: "s1",
      message: { id: "msg_1", role: "assistant", model: "claude-opus-4-8", usage },
    });
    const fresh = line({
      uuid: "d9",
      sessionId: "s2",
      requestId: "req_2",
      message: { id: "msg_9", role: "assistant", model: "claude-opus-4-8", usage },
    });
    await fs.writeFile(path.join(projDir, "s1.jsonl"), original + "\n");
    // Continuation file: replays the s1 turn verbatim, then adds a new one.
    await fs.writeFile(path.join(projDir, "s2.jsonl"), original + "\n" + fresh + "\n");

    const entries = await loadAllEntries(dir);
    expect(entries).toHaveLength(2); // msg_1 once + msg_9 once
    const total = entries.reduce((sum, e) => sum + (e.usage?.inputTokens ?? 0), 0);
    expect(total).toBe(200); // not 300
  });
});

describe("loadAllEntries", () => {
  it("loads every session under projects/", async () => {
    const entries = await loadAllEntries(FIXTURES);
    expect(entries).toHaveLength(10); // 7 from session A + 3 from session B
    expect(new Set(entries.map((e) => e.project))).toEqual(
      new Set(["/home/dev/webapp", "/home/dev/api"]),
    );
  });

  it("returns an empty array when the directory does not exist", async () => {
    expect(await loadAllEntries("/nonexistent/claude-home")).toEqual([]);
  });
});
