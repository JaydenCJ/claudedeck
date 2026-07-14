/**
 * Configuration editing: enable/disable and create skills, agents, commands
 * and hooks. This is the write-side counterpart of `inspect.ts` and powers
 * `claudedeck skills enable|disable|new`, `claudedeck hooks enable|disable`,
 * and the dashboard's edit buttons.
 *
 * Mechanisms (both are no-ops from Claude Code's point of view until re-enabled):
 * - Assets (skills/agents/commands) are disabled by renaming the markdown
 *   file with a `.disabled` suffix — Claude Code only loads `*.md` /
 *   `SKILL.md`, so the renamed file is inert but keeps its content.
 * - Hooks are disabled by moving the hook entry from the settings file's
 *   `hooks` section to a `disabledHooks` section with the same shape.
 *   Claude Code ignores unknown top-level settings keys, so the definition
 *   is preserved verbatim and can be moved back.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DISABLED_SUFFIX } from "./inspect.js";
import type { AssetInfo } from "../types.js";

/** Asset/hook names must be simple identifiers — this also blocks path tricks. */
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeName(name: string): void {
  if (!SAFE_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`invalid name "${name}" (letters, digits, ".", "_" and "-" only)`);
  }
}

/** Result of a toggle: the asset's current path plus whether anything changed. */
export interface ToggleResult {
  filePath: string;
  /** false when the asset/hook was already in the requested state (no-op). */
  changed: boolean;
}

/**
 * Enable or disable an asset file by adding/removing the `.disabled` suffix.
 * Returns the file's new path and whether a rename actually happened.
 * Idempotent: enabling an enabled asset (or disabling a disabled one) is a
 * no-op reported via `changed: false`.
 */
export async function setAssetEnabled(filePath: string, enabled: boolean): Promise<ToggleResult> {
  const isDisabled = filePath.endsWith(DISABLED_SUFFIX);
  const basePath = isDisabled ? filePath.slice(0, -DISABLED_SUFFIX.length) : filePath;
  if (!basePath.endsWith(".md")) {
    throw new Error(
      `refusing to toggle "${filePath}": only markdown assets (.md / .md${DISABLED_SUFFIX}) can be enabled or disabled`,
    );
  }
  if (enabled === !isDisabled) return { filePath, changed: false }; // already in the requested state
  const newPath = enabled
    ? filePath.slice(0, -DISABLED_SUFFIX.length)
    : filePath + DISABLED_SUFFIX;
  await fs.rename(filePath, newPath);
  return { filePath: newPath, changed: true };
}

/** Markdown asset files larger than this are refused by the content editor. */
export const MAX_ASSET_BYTES = 256 * 1024;

function assertMarkdownAsset(filePath: string): void {
  const basePath = filePath.endsWith(DISABLED_SUFFIX)
    ? filePath.slice(0, -DISABLED_SUFFIX.length)
    : filePath;
  if (!basePath.endsWith(".md")) {
    throw new Error(
      `refusing to edit "${filePath}": only markdown assets (.md / .md${DISABLED_SUFFIX}) can be read or written`,
    );
  }
}

/**
 * Read a skill/agent/command markdown file for the content editor.
 * Only markdown assets are allowed; callers must confine `filePath` to the
 * Claude home before calling.
 */
export async function readAssetContent(filePath: string): Promise<string> {
  assertMarkdownAsset(filePath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`"${filePath}" is not a regular file`);
  if (stat.size > MAX_ASSET_BYTES) {
    throw new Error(`"${filePath}" is larger than ${MAX_ASSET_BYTES} bytes — edit it with a local editor`);
  }
  return fs.readFile(filePath, "utf8");
}

/**
 * Overwrite a skill/agent/command markdown file with new content.
 * Refuses to create new files (use `createAsset` for that) so a typo'd path
 * can never scatter stray files around the Claude home.
 */
export async function writeAssetContent(filePath: string, content: string): Promise<void> {
  assertMarkdownAsset(filePath);
  if (Buffer.byteLength(content, "utf8") > MAX_ASSET_BYTES) {
    throw new Error(`content exceeds ${MAX_ASSET_BYTES} bytes`);
  }
  const stat = await fs.stat(filePath); // throws ENOENT for nonexistent assets
  if (!stat.isFile()) throw new Error(`"${filePath}" is not a regular file`);
  await fs.writeFile(filePath, content, "utf8");
}

const TEMPLATES: Record<AssetInfo["kind"], (name: string) => string> = {
  skill: (name) => `---
name: ${name}
description: Describe when Claude should use this skill.
---

# ${name}

Instructions for the skill go here.
`,
  agent: (name) => `---
name: ${name}
description: Describe what this agent does and when to delegate to it.
tools: Read, Grep, Glob
---

You are the ${name} agent. Describe your behavior here.
`,
  command: (name) => `---
description: Describe what /${name} does.
---

Steps for /${name} go here.
`,
};

/** Where a new asset of a given kind lives inside the Claude home. */
export function assetPath(claudeHome: string, kind: AssetInfo["kind"], name: string): string {
  switch (kind) {
    case "skill":
      return path.join(claudeHome, "skills", name, "SKILL.md");
    case "agent":
      return path.join(claudeHome, "agents", `${name}.md`);
    case "command":
      return path.join(claudeHome, "commands", `${name}.md`);
  }
}

/**
 * Create a new skill/agent/command from a starter template.
 * Refuses to overwrite an existing asset (enabled or disabled).
 * Returns the created file's path.
 */
export async function createAsset(
  claudeHome: string,
  kind: AssetInfo["kind"],
  name: string,
): Promise<string> {
  assertSafeName(name);
  const target = assetPath(claudeHome, kind, name);
  for (const existing of [target, target + DISABLED_SUFFIX]) {
    try {
      await fs.stat(existing);
      throw new Error(`${kind} "${name}" already exists at ${existing}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("already exists")) throw err;
      // ENOENT — free to create.
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, TEMPLATES[kind](name), "utf8");
  return target;
}

/** Identifies one hook entry inside a settings file. */
export interface HookRef {
  /** Settings file name relative to the Claude home, e.g. `settings.json`. */
  source: string;
  event: string;
  matcher?: string;
  command?: string;
}

interface RawHookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}

interface RawHookMatcher {
  matcher?: string;
  hooks?: RawHookEntry[];
}

type HooksSection = Record<string, RawHookMatcher[]>;

const HOOK_SOURCES = new Set(["settings.json", "settings.local.json"]);

function sameMatcher(m: RawHookMatcher, ref: HookRef): boolean {
  return (m.matcher ?? undefined) === (ref.matcher ?? undefined);
}

function findHook(
  section: HooksSection | undefined,
  ref: HookRef,
): { matcher: RawHookMatcher; index: number } | undefined {
  const matchers = section?.[ref.event];
  if (!Array.isArray(matchers)) return undefined;
  for (const m of matchers) {
    if (!sameMatcher(m, ref) || !Array.isArray(m.hooks)) continue;
    const index = m.hooks.findIndex(
      (h) => (h.command ?? undefined) === (ref.command ?? undefined),
    );
    if (index !== -1) return { matcher: m, index };
  }
  return undefined;
}

function insertHook(root: Record<string, unknown>, key: "hooks" | "disabledHooks", ref: HookRef, hook: RawHookEntry): void {
  const section = (root[key] ??= {}) as HooksSection;
  const matchers = (section[ref.event] ??= []);
  let target = matchers.find((m) => sameMatcher(m, ref));
  if (!target) {
    target = ref.matcher === undefined ? { hooks: [] } : { matcher: ref.matcher, hooks: [] };
    matchers.push(target);
  }
  (target.hooks ??= []).push(hook);
}

function pruneEmpty(root: Record<string, unknown>, key: "hooks" | "disabledHooks"): void {
  const section = root[key] as HooksSection | undefined;
  if (typeof section !== "object" || section === null) return;
  for (const [event, matchers] of Object.entries(section)) {
    if (!Array.isArray(matchers)) continue;
    const kept = matchers.filter((m) => (m.hooks?.length ?? 0) > 0);
    if (kept.length === 0) delete section[event];
    else section[event] = kept;
  }
  if (Object.keys(section).length === 0) delete root[key];
}

/**
 * Enable or disable a hook by moving it between the `hooks` and
 * `disabledHooks` sections of its settings file. Returns whether the hook
 * actually moved (`false` = it was already in the requested state). Throws
 * when the referenced hook cannot be found in either section.
 */
export async function setHookEnabled(
  claudeHome: string,
  ref: HookRef,
  enabled: boolean,
): Promise<boolean> {
  if (!HOOK_SOURCES.has(ref.source)) {
    throw new Error(`invalid hook source "${ref.source}" (expected settings.json or settings.local.json)`);
  }
  const file = path.join(claudeHome, ref.source);
  const content = await fs.readFile(file, "utf8");
  const root = JSON.parse(content) as Record<string, unknown>;

  const fromKey = enabled ? "disabledHooks" : "hooks";
  const toKey = enabled ? "hooks" : "disabledHooks";
  const found = findHook(root[fromKey] as HooksSection | undefined, ref);
  if (!found) {
    // Idempotence: if it is already in the requested state, do nothing.
    if (findHook(root[toKey] as HooksSection | undefined, ref)) return false;
    throw new Error(
      `hook not found in ${ref.source}: event=${ref.event} matcher=${ref.matcher ?? "*"} command=${ref.command ?? "?"}`,
    );
  }

  const [hook] = found.matcher.hooks!.splice(found.index, 1);
  insertHook(root, toKey as "hooks" | "disabledHooks", ref, hook);
  pruneEmpty(root, fromKey as "hooks" | "disabledHooks");

  await fs.writeFile(file, JSON.stringify(root, null, 2) + "\n", "utf8");
  return true;
}

/**
 * Find one asset by name across skills, agents and commands.
 * Throws when the name is missing or ambiguous (unless `kind` narrows it).
 */
export function findAssetByName(
  assets: { skills: AssetInfo[]; agents: AssetInfo[]; commands: AssetInfo[] },
  name: string,
  kind?: AssetInfo["kind"],
): AssetInfo {
  const pool = [...assets.skills, ...assets.agents, ...assets.commands].filter(
    (a) => a.name === name && (!kind || a.kind === kind),
  );
  if (pool.length === 0) {
    throw new Error(`no skill/agent/command named "${name}"${kind ? ` of kind ${kind}` : ""}`);
  }
  if (pool.length > 1) {
    throw new Error(
      `"${name}" is ambiguous (${pool.map((a) => a.kind).join(", ")}) — pass --kind skill|agent|command`,
    );
  }
  return pool[0];
}
