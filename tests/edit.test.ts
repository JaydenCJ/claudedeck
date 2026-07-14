import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectConfig } from "../src/config/inspect.js";
import {
  assetPath,
  createAsset,
  findAssetByName,
  readAssetContent,
  setAssetEnabled,
  setHookEnabled,
  writeAssetContent,
} from "../src/config/edit.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-home");

/** Copy the fixture Claude home into a temp dir so edits never touch fixtures. */
async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claudedeck-edit-"));
  await fs.cp(FIXTURES, dir, { recursive: true });
  return dir;
}

describe("setAssetEnabled", () => {
  it("disables an asset by renaming it with .disabled and re-enables it back", async () => {
    const home = await tempHome();
    const original = path.join(home, "skills", "changelog", "SKILL.md");

    const disabled = await setAssetEnabled(original, false);
    expect(disabled).toEqual({ filePath: original + ".disabled", changed: true });
    await expect(fs.stat(original)).rejects.toThrow();
    await expect(fs.stat(disabled.filePath)).resolves.toBeDefined();
    const disabledPath = disabled.filePath;

    // The inspector still lists it, marked disabled.
    let cfg = await inspectConfig(home);
    expect(cfg.skills).toHaveLength(1);
    expect(cfg.skills[0].enabled).toBe(false);
    expect(cfg.skills[0].name).toBe("changelog");

    const enabled = await setAssetEnabled(disabledPath, true);
    expect(enabled).toEqual({ filePath: original, changed: true });
    cfg = await inspectConfig(home);
    expect(cfg.skills[0].enabled).toBe(true);
  });

  it("is idempotent and reports no-ops via changed: false", async () => {
    const home = await tempHome();
    const original = path.join(home, "agents", "code-reviewer.md");
    expect(await setAssetEnabled(original, true)).toEqual({ filePath: original, changed: false });
    const disabled = await setAssetEnabled(original, false);
    expect(disabled.changed).toBe(true);
    expect(await setAssetEnabled(disabled.filePath, false)).toEqual({
      filePath: disabled.filePath,
      changed: false,
    });
  });

  it("refuses to toggle non-markdown files (e.g. settings.json)", async () => {
    const home = await tempHome();
    const settings = path.join(home, "settings.json");
    await expect(setAssetEnabled(settings, false)).rejects.toThrow(/only markdown assets/);
    await expect(setAssetEnabled(settings + ".disabled", true)).rejects.toThrow(/only markdown assets/);
    // The real settings file is untouched.
    await expect(fs.stat(settings)).resolves.toBeDefined();
  });
});

describe("createAsset", () => {
  it("creates a skill from a template at skills/<name>/SKILL.md", async () => {
    const home = await tempHome();
    const file = await createAsset(home, "skill", "release-notes");
    expect(file).toBe(assetPath(home, "skill", "release-notes"));
    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("name: release-notes");
    const cfg = await inspectConfig(home);
    expect(cfg.skills.map((s) => s.name)).toContain("release-notes");
  });

  it("creates agents and commands as <name>.md", async () => {
    const home = await tempHome();
    const agent = await createAsset(home, "agent", "tester");
    const command = await createAsset(home, "command", "ship");
    expect(agent).toBe(path.join(home, "agents", "tester.md"));
    expect(command).toBe(path.join(home, "commands", "ship.md"));
    const cfg = await inspectConfig(home);
    expect(cfg.agents.map((a) => a.name)).toContain("tester");
    expect(cfg.commands.map((c) => c.name)).toContain("ship");
  });

  it("refuses to overwrite an existing asset, even a disabled one", async () => {
    const home = await tempHome();
    await expect(createAsset(home, "skill", "changelog")).rejects.toThrow(/already exists/);
    await setAssetEnabled(path.join(home, "skills", "changelog", "SKILL.md"), false);
    await expect(createAsset(home, "skill", "changelog")).rejects.toThrow(/already exists/);
  });

  it("rejects names with path separators or traversal", async () => {
    const home = await tempHome();
    await expect(createAsset(home, "skill", "../evil")).rejects.toThrow(/invalid name/);
    await expect(createAsset(home, "agent", "a/b")).rejects.toThrow(/invalid name/);
    await expect(createAsset(home, "command", "")).rejects.toThrow(/invalid name/);
  });
});

describe("setHookEnabled", () => {
  it("moves a hook to disabledHooks and back, preserving its definition", async () => {
    const home = await tempHome();
    const ref = {
      source: "settings.json",
      event: "PreToolUse",
      matcher: "Bash",
      command: "echo pre-bash >> /tmp/hooks.log",
    };

    await setHookEnabled(home, ref, false);
    let settings = JSON.parse(await fs.readFile(path.join(home, "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toBeUndefined(); // emptied section pruned
    expect(settings.disabledHooks.PreToolUse[0].matcher).toBe("Bash");
    expect(settings.disabledHooks.PreToolUse[0].hooks[0].command).toBe(ref.command);
    expect(settings.disabledHooks.PreToolUse[0].hooks[0].timeout).toBe(10);

    // The inspector reports it as disabled; other hooks stay enabled.
    let cfg = await inspectConfig(home);
    const pre = cfg.hooks.find((h) => h.event === "PreToolUse")!;
    expect(pre.enabled).toBe(false);
    expect(cfg.hooks.filter((h) => h.enabled)).toHaveLength(2);

    await setHookEnabled(home, ref, true);
    settings = JSON.parse(await fs.readFile(path.join(home, "settings.json"), "utf8"));
    expect(settings.disabledHooks).toBeUndefined();
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(10);
    cfg = await inspectConfig(home);
    expect(cfg.hooks.every((h) => h.enabled)).toBe(true);
  });

  it("handles hooks in settings.local.json and without a matcher", async () => {
    const home = await tempHome();
    const ref = { source: "settings.local.json", event: "Stop", command: "notify-send 'Claude finished'" };
    await setHookEnabled(home, ref, false);
    const local = JSON.parse(await fs.readFile(path.join(home, "settings.local.json"), "utf8"));
    expect(local.hooks).toBeUndefined();
    expect(local.disabledHooks.Stop[0].hooks[0].command).toBe(ref.command);
  });

  it("is a no-op (returning false) when the hook is already in the requested state", async () => {
    const home = await tempHome();
    const ref = { source: "settings.local.json", event: "Stop", command: "notify-send 'Claude finished'" };
    expect(await setHookEnabled(home, ref, true)).toBe(false); // already enabled
    const local = JSON.parse(await fs.readFile(path.join(home, "settings.local.json"), "utf8"));
    expect(local.hooks.Stop[0].hooks[0].command).toBe(ref.command);
  });

  it("throws for unknown hooks and invalid sources", async () => {
    const home = await tempHome();
    await expect(
      setHookEnabled(home, { source: "settings.json", event: "Nope", command: "x" }, false),
    ).rejects.toThrow(/hook not found/);
    await expect(
      setHookEnabled(home, { source: "../evil.json", event: "Stop" }, false),
    ).rejects.toThrow(/invalid hook source/);
  });
});

describe("readAssetContent / writeAssetContent", () => {
  it("round-trips a skill file's content", async () => {
    const home = await tempHome();
    const skill = path.join(home, "skills", "changelog", "SKILL.md");
    const original = await readAssetContent(skill);
    expect(original).toContain("changelog");

    const updated = original + "\nExtra instructions added by the editor.\n";
    await writeAssetContent(skill, updated);
    expect(await readAssetContent(skill)).toBe(updated);
  });

  it("edits disabled assets too (the .disabled suffix keeps the .md base)", async () => {
    const home = await tempHome();
    const skill = path.join(home, "skills", "changelog", "SKILL.md");
    const { filePath: disabled } = await setAssetEnabled(skill, false);
    await writeAssetContent(disabled, "# rewritten while disabled\n");
    expect(await readAssetContent(disabled)).toBe("# rewritten while disabled\n");
  });

  it("refuses non-markdown files", async () => {
    const home = await tempHome();
    const settings = path.join(home, "settings.json");
    await expect(readAssetContent(settings)).rejects.toThrow(/only markdown assets/);
    await expect(writeAssetContent(settings, "{}")).rejects.toThrow(/only markdown assets/);
  });

  it("refuses to create files that do not exist yet", async () => {
    const home = await tempHome();
    const ghost = path.join(home, "skills", "ghost", "SKILL.md");
    await expect(writeAssetContent(ghost, "boo")).rejects.toThrow();
    await expect(fs.stat(ghost)).rejects.toThrow();
  });
});

describe("findAssetByName", () => {
  it("finds a unique asset across kinds", async () => {
    const cfg = await inspectConfig(FIXTURES);
    expect(findAssetByName(cfg, "changelog").kind).toBe("skill");
    expect(findAssetByName(cfg, "deploy").kind).toBe("command");
  });

  it("throws for unknown names and honors the kind filter", async () => {
    const cfg = await inspectConfig(FIXTURES);
    expect(() => findAssetByName(cfg, "nope")).toThrow(/no skill\/agent\/command/);
    expect(() => findAssetByName(cfg, "changelog", "agent")).toThrow(/no skill\/agent\/command/);
  });
});
