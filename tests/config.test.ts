import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectConfig, parseFrontmatter } from "../src/config/inspect.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-home");

describe("parseFrontmatter", () => {
  it("parses flat key/value frontmatter and returns the body", () => {
    const { meta, body } = parseFrontmatter("---\nname: x\ndescription: \"a b\"\n---\nBody here\n");
    expect(meta).toEqual({ name: "x", description: "a b" });
    expect(body.trim()).toBe("Body here");
  });

  it("returns empty meta when no frontmatter exists", () => {
    const { meta, body } = parseFrontmatter("just a body");
    expect(meta).toEqual({});
    expect(body).toBe("just a body");
  });
});

describe("inspectConfig", () => {
  it("finds agents with their frontmatter", async () => {
    const cfg = await inspectConfig(FIXTURES);
    expect(cfg.agents).toHaveLength(1);
    const agent = cfg.agents[0];
    expect(agent.name).toBe("code-reviewer");
    expect(agent.description).toMatch(/pull requests/);
    expect(agent.meta.tools).toBe("Read, Grep, Glob");
    expect(agent.meta.model).toBe("claude-haiku-4-5");
  });

  it("finds commands and skills", async () => {
    const cfg = await inspectConfig(FIXTURES);
    expect(cfg.commands.map((c) => c.name)).toEqual(["deploy"]);
    expect(cfg.commands[0].description).toMatch(/staging/);
    expect(cfg.skills.map((s) => s.name)).toEqual(["changelog"]);
  });

  it("collects hooks from both settings files with their source", async () => {
    const cfg = await inspectConfig(FIXTURES);
    expect(cfg.hooks).toHaveLength(3);
    const events = cfg.hooks.map((h) => h.event).sort();
    expect(events).toEqual(["PreToolUse", "SessionStart", "Stop"]);
    const pre = cfg.hooks.find((h) => h.event === "PreToolUse")!;
    expect(pre.matcher).toBe("Bash");
    expect(pre.command).toContain("pre-bash");
    expect(pre.timeout).toBe(10);
    expect(pre.source).toBe("settings.json");
    const stop = cfg.hooks.find((h) => h.event === "Stop")!;
    expect(stop.source).toBe("settings.local.json");
  });

  it("collects MCP servers with command or url", async () => {
    const cfg = await inspectConfig(FIXTURES);
    const byName = Object.fromEntries(cfg.mcpServers.map((s) => [s.name, s]));
    expect(byName["github"].command).toBe("npx -y @modelcontextprotocol/server-github");
    expect(byName["slack"].url).toBe("https://mcp.slack.com/mcp");
  });

  it("reads MCP servers from the ~/.claude.json sibling file (top-level and per-project)", async () => {
    // Claude Code's primary MCP registry is `.claude.json` *next to* the
    // `.claude` directory, not settings.json — real setups keep servers there.
    const cfg = await inspectConfig(FIXTURES);
    const byName = Object.fromEntries(cfg.mcpServers.map((s) => [s.name, s]));
    expect(byName["filesystem"].command).toBe(
      "npx -y @modelcontextprotocol/server-filesystem /home/dev",
    );
    expect(byName["filesystem"].source).toBe(".claude.json");
    expect(byName["playwright"].command).toBe("npx -y @playwright/mcp");
    expect(byName["playwright"].source).toBe(".claude.json (project: /home/dev/webapp)");
  });

  it("reads project-scoped MCP servers from <projectDir>/.mcp.json", async () => {
    const projectDir = path.join(path.dirname(FIXTURES), "project");
    const cfg = await inspectConfig(FIXTURES, { projectDir });
    const linear = cfg.mcpServers.find((s) => s.name === "linear")!;
    expect(linear.url).toBe("https://mcp.linear.app/mcp");
    expect(linear.source).toBe(".mcp.json");
    // Without a projectDir, .mcp.json is not consulted.
    const cfgNoProject = await inspectConfig(FIXTURES);
    expect(cfgNoProject.mcpServers.find((s) => s.name === "linear")).toBeUndefined();
  });

  it("marks every fixture asset and hook as enabled", async () => {
    const cfg = await inspectConfig(FIXTURES);
    expect([...cfg.skills, ...cfg.agents, ...cfg.commands].every((a) => a.enabled)).toBe(true);
    expect(cfg.hooks.every((h) => h.enabled)).toBe(true);
  });

  it("returns empty results for a directory with no config", async () => {
    const cfg = await inspectConfig("/nonexistent/claude-home");
    expect(cfg.agents).toEqual([]);
    expect(cfg.hooks).toEqual([]);
    expect(cfg.settingsFiles).toEqual([]);
  });
});
