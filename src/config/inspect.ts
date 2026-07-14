/**
 * Configuration inspector for a Claude Code home directory (`~/.claude`).
 *
 * Produces a structured view of:
 * - agents      (`agents/*.md` with YAML frontmatter)
 * - commands    (`commands/**​/*.md`)
 * - skills      (`skills/<name>/SKILL.md`)
 * - hooks       (from `settings.json` / `settings.local.json`, including the
 *                claudedeck-managed `disabledHooks` section)
 * - MCP servers (from settings files, the `~/.claude.json` sibling file —
 *                both its top level and per-project `projects.*.mcpServers` —
 *                and the project-local `.mcp.json`)
 *
 * Assets renamed with the `.disabled` suffix (claudedeck's enable/disable
 * mechanism — Claude Code only loads `*.md`, so a `.disabled` file is inert)
 * are still listed, with `enabled: false`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AssetInfo, ConfigInspection, HookInfo } from "../types.js";

/** Suffix appended to an asset file to disable it without deleting it. */
export const DISABLED_SUFFIX = ".disabled";

/**
 * Minimal YAML frontmatter parser — handles the flat `key: value` frontmatter
 * Claude Code uses for agents/commands/skills without pulling in a YAML dep.
 */
export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!content.startsWith("---")) return { meta, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { meta, body: content };
  const header = content.slice(3, end);
  const body = content.slice(content.indexOf("\n", end + 1) + 1);
  for (const line of header.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[m[1]] = value;
  }
  return { meta, body };
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function isAssetFile(name: string): boolean {
  return name.endsWith(".md") || name.endsWith(".md" + DISABLED_SUFFIX);
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return results;
  }
  for (const name of names.sort()) {
    const abs = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...(await listMarkdownFiles(abs)));
    } else if (isAssetFile(name)) {
      results.push(abs);
    }
  }
  return results;
}

async function inspectAssets(
  dir: string,
  kind: AssetInfo["kind"],
): Promise<AssetInfo[]> {
  const assets: AssetInfo[] = [];
  for (const file of await listMarkdownFiles(dir)) {
    const content = await readIfExists(file);
    if (content === undefined) continue;
    const { meta } = parseFrontmatter(content);
    const enabled = !file.endsWith(DISABLED_SUFFIX);
    const enabledPath = enabled ? file : file.slice(0, -DISABLED_SUFFIX.length);
    const fallbackName =
      kind === "skill"
        ? path.basename(path.dirname(file))
        : path.basename(enabledPath, ".md");
    assets.push({
      kind,
      name: meta.name || fallbackName,
      description: meta.description,
      meta,
      filePath: file,
      enabled,
    });
  }
  return assets;
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

function extractHooks(
  section: unknown,
  source: string,
  enabled: boolean,
): HookInfo[] {
  const hooks: HookInfo[] = [];
  if (typeof section !== "object" || section === null) return hooks;
  for (const [event, matchers] of Object.entries(section as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers as RawHookMatcher[]) {
      for (const h of m?.hooks ?? []) {
        hooks.push({
          event,
          matcher: m.matcher,
          type: h.type ?? "command",
          command: h.command,
          timeout: h.timeout,
          source,
          enabled,
        });
      }
    }
  }
  return hooks;
}

function extractMcpServers(
  section: unknown,
  source: string,
): ConfigInspection["mcpServers"] {
  const out: ConfigInspection["mcpServers"] = [];
  if (typeof section !== "object" || section === null) return out;
  for (const [name, cfg] of Object.entries(section as Record<string, unknown>)) {
    const c = cfg as { command?: string; args?: string[]; url?: string } | null;
    out.push({
      name,
      command: c?.command ? [c.command, ...(c.args ?? [])].join(" ") : undefined,
      url: c?.url,
      source,
    });
  }
  return out;
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  const content = await readIfExists(filePath);
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return undefined; // a broken file should not abort inspection
  }
}

export interface InspectOptions {
  /**
   * Project directory whose `.mcp.json` should be included in the MCP server
   * list (Claude Code reads project-scoped servers from `<project>/.mcp.json`).
   * Typically `process.cwd()`. Omit to skip project-scoped servers.
   */
  projectDir?: string;
}

/** Inspect a Claude Code home directory and return its structured configuration. */
export async function inspectConfig(
  claudeHome: string,
  opts: InspectOptions = {},
): Promise<ConfigInspection> {
  const result: ConfigInspection = {
    agents: await inspectAssets(path.join(claudeHome, "agents"), "agent"),
    commands: await inspectAssets(path.join(claudeHome, "commands"), "command"),
    skills: (await inspectAssets(path.join(claudeHome, "skills"), "skill")).filter(
      (s) => s.filePath.endsWith("SKILL.md") || s.filePath.endsWith("SKILL.md" + DISABLED_SUFFIX),
    ),
    hooks: [],
    mcpServers: [],
    settingsFiles: [],
  };

  for (const file of ["settings.json", "settings.local.json"]) {
    const abs = path.join(claudeHome, file);
    const parsed = await readJsonIfExists(abs);
    if (parsed === undefined) {
      // Distinguish missing from unparseable: only record existing files.
      if ((await readIfExists(abs)) !== undefined) result.settingsFiles.push(abs);
      continue;
    }
    result.settingsFiles.push(abs);
    result.hooks.push(...extractHooks(parsed.hooks, file, true));
    result.hooks.push(...extractHooks(parsed.disabledHooks, file, false));
    result.mcpServers.push(...extractMcpServers(parsed.mcpServers, file));
  }

  // Claude Code's primary MCP registry is `~/.claude.json` — a *sibling* of
  // the `~/.claude` directory, not inside it. It has a top-level `mcpServers`
  // map plus per-project maps under `projects.<abs-path>.mcpServers`.
  const dotClaudeJson = path.join(path.dirname(path.resolve(claudeHome)), ".claude.json");
  const claudeJson = await readJsonIfExists(dotClaudeJson);
  if (claudeJson !== undefined) {
    result.settingsFiles.push(dotClaudeJson);
    result.mcpServers.push(...extractMcpServers(claudeJson.mcpServers, ".claude.json"));
    const projects = claudeJson.projects;
    if (typeof projects === "object" && projects !== null) {
      for (const [projectPath, projectCfg] of Object.entries(projects as Record<string, unknown>)) {
        const p = projectCfg as { mcpServers?: unknown } | null;
        result.mcpServers.push(
          ...extractMcpServers(p?.mcpServers, `.claude.json (project: ${projectPath})`),
        );
      }
    }
  }

  // Project-scoped servers checked into the repo: `<project>/.mcp.json`.
  if (opts.projectDir) {
    const mcpJsonPath = path.join(opts.projectDir, ".mcp.json");
    const mcpJson = await readJsonIfExists(mcpJsonPath);
    if (mcpJson !== undefined) {
      result.settingsFiles.push(mcpJsonPath);
      result.mcpServers.push(...extractMcpServers(mcpJson.mcpServers, ".mcp.json"));
    }
  }

  return result;
}
