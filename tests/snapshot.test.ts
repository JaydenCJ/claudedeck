import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSnapshot,
  exportSnapshot,
  importSnapshot,
  readSnapshot,
  redactSettingsContent,
} from "../src/sync/snapshot.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-home");

async function tmpdir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("redactSettingsContent", () => {
  it("removes sensitive keys recursively and records their paths", () => {
    const redactions: string[] = [];
    const out = redactSettingsContent(
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: "sk-ant-abc123456789", KEEP: "yes" },
        mcpServers: { gh: { env: { GITHUB_TOKEN: "ghp_x" } } },
        nested: { authorization: "Bearer x" },
      }),
      "settings.json",
      redactions,
    );
    const parsed = JSON.parse(out);
    expect(parsed.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(parsed.env.KEEP).toBe("yes");
    expect(parsed.mcpServers.gh.env.GITHUB_TOKEN).toBeUndefined();
    expect(parsed.nested.authorization).toBeUndefined();
    expect(redactions).toContain("settings.json:env.ANTHROPIC_API_KEY");
    expect(redactions).toContain("settings.json:mcpServers.gh.env.GITHUB_TOKEN");
    expect(redactions).toContain("settings.json:nested.authorization");
  });

  it("scrubs sk-ant keys embedded in non-sensitive string values", () => {
    const redactions: string[] = [];
    const out = redactSettingsContent(
      JSON.stringify({ note: "my key is sk-ant-api03-super-secret-value" }),
      "settings.json",
      redactions,
    );
    expect(out).not.toContain("sk-ant-");
    expect(out).toContain("[REDACTED]");
    expect(redactions).toContain("settings.json:note");
  });
});

describe("createSnapshot / exportSnapshot", () => {
  it("packs agents, commands, skills, settings and CLAUDE.md", async () => {
    const snapshot = await createSnapshot(FIXTURES);
    const files = Object.keys(snapshot.files).sort();
    expect(files).toEqual([
      "CLAUDE.md",
      "agents/code-reviewer.md",
      "commands/deploy.md",
      "settings.json",
      "skills/changelog/SKILL.md",
    ]);
    expect(snapshot.version).toBe(1);
    expect(snapshot.tool).toBe("claudedeck");
  });

  it("strips secrets by default — no sk-ant / token values anywhere in the snapshot", async () => {
    const snapshot = await createSnapshot(FIXTURES);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("sk-ant-");
    expect(serialized).not.toContain("ghp_fixture_secret");
    expect(serialized).not.toContain("xoxb-fixture");
    expect(snapshot.redactions).toContain("settings.json:env.ANTHROPIC_API_KEY");
    expect(snapshot.redactions).toContain("settings.json:apiKeyHelper");
    expect(snapshot.redactions).toContain("settings.json:mcpServers.github.env.GITHUB_TOKEN");
    expect(snapshot.redactions).toContain("settings.json:mcpServers.slack.headers.Authorization");
    // Non-sensitive config survives, including keys that merely *contain* "tokens".
    const settings = JSON.parse(snapshot.files["settings.json"]);
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.mcpServers.github.command).toBe("npx");
    expect(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32000");
  });

  it("keeps secrets only with the explicit opt-in", async () => {
    const snapshot = await createSnapshot(FIXTURES, { includeSecrets: true });
    expect(snapshot.files["settings.json"]).toContain("sk-ant-");
    expect(snapshot.redactions).toEqual([]);
  });

  it("writes a readable snapshot file", async () => {
    const dir = await tmpdir("claudedeck-export-");
    const out = path.join(dir, "snap.json");
    await exportSnapshot(FIXTURES, out);
    const roundTripped = await readSnapshot(out);
    expect(Object.keys(roundTripped.files)).toHaveLength(5);
  });
});

describe("importSnapshot", () => {
  it("writes snapshot files into an empty target", async () => {
    const exportDir = await tmpdir("claudedeck-exp-");
    const target = await tmpdir("claudedeck-target-");
    const out = path.join(exportDir, "snap.json");
    await exportSnapshot(FIXTURES, out);

    const result = await importSnapshot(out, target);
    expect(result.written.sort()).toContain("agents/code-reviewer.md");
    expect(result.skipped).toEqual([]);
    const agent = await fs.readFile(path.join(target, "agents", "code-reviewer.md"), "utf8");
    expect(agent).toContain("code-reviewer");
    expect(result.redactions.length).toBeGreaterThan(0);
  });

  it("skips existing files unless --force", async () => {
    const exportDir = await tmpdir("claudedeck-exp-");
    const target = await tmpdir("claudedeck-target-");
    const out = path.join(exportDir, "snap.json");
    await exportSnapshot(FIXTURES, out);

    await fs.mkdir(path.join(target, "agents"), { recursive: true });
    await fs.writeFile(path.join(target, "agents", "code-reviewer.md"), "local version");

    const first = await importSnapshot(out, target);
    expect(first.skipped).toEqual(["agents/code-reviewer.md"]);
    expect(await fs.readFile(path.join(target, "agents", "code-reviewer.md"), "utf8")).toBe("local version");

    const second = await importSnapshot(out, target, { force: true });
    expect(second.written).toContain("agents/code-reviewer.md");
    expect(await fs.readFile(path.join(target, "agents", "code-reviewer.md"), "utf8")).toContain("meticulous");
  });

  it("refuses path traversal outside the target directory", async () => {
    const dir = await tmpdir("claudedeck-evil-");
    const target = await tmpdir("claudedeck-target-");
    const evil = path.join(dir, "evil.json");
    await fs.writeFile(
      evil,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        tool: "claudedeck",
        files: { "../pwned.txt": "boom" },
        redactions: [],
      }),
    );
    const result = await importSnapshot(evil, target);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(["../pwned.txt"]);
    await expect(fs.stat(path.join(path.dirname(target), "pwned.txt"))).rejects.toThrow();
  });

  it("rejects files that are not claudedeck snapshots", async () => {
    const dir = await tmpdir("claudedeck-bad-");
    const bad = path.join(dir, "bad.json");
    await fs.writeFile(bad, JSON.stringify({ hello: "world" }));
    await expect(importSnapshot(bad, dir)).rejects.toThrow(/not a claudedeck snapshot/);
  });
});
