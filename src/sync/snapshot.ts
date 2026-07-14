/**
 * Config snapshot export / import.
 *
 * `claudedeck sync export` packs the portable parts of a Claude Code home
 * directory (settings, agents, commands, skills, CLAUDE.md) into a single
 * JSON snapshot that can be committed, copied to another machine, and
 * re-applied with `claudedeck sync import`.
 *
 * Security: secrets are stripped by default. Any JSON key matching the
 * sensitive-key pattern (apiKey, token, secret, password, ...) is removed
 * recursively from settings files, and any string value that looks like an
 * Anthropic API key (`sk-ant-...`) is redacted wherever it appears. The
 * removed key paths are recorded in the snapshot's `redactions` list so the
 * import side knows what must be re-provisioned manually.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const SNAPSHOT_VERSION = 1;

// `token(?!s)` avoids false positives like CLAUDE_CODE_MAX_OUTPUT_TOKENS while
// still catching GITHUB_TOKEN / authToken / access_token.
const SENSITIVE_KEY_RE = /(api[_-]?key|token(?!s)|secret|password|credential|authorization|private[_-]?key)/i;
// Note: no /g flag on the test regex — a global regex keeps lastIndex between
// .test() calls, which makes alternating calls silently return false.
const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_-]{8,}/;
const ANTHROPIC_KEY_RE_ALL = /sk-ant-[A-Za-z0-9_-]{8,}/g;
const REDACTED = "[REDACTED]";

/**
 * Directories / files included in a snapshot, relative to the Claude home.
 *
 * Deliberately excluded:
 * - `settings.local.json` — machine-local overrides (local hooks, per-machine
 *   permissions); syncing it to another machine is exactly what it exists to
 *   avoid.
 * - `projects/` session logs and any cache/state files — snapshots carry
 *   configuration, not usage data.
 */
const SNAPSHOT_DIRS = ["agents", "commands", "skills"];
const SNAPSHOT_FILES = ["settings.json", "CLAUDE.md"];

export interface Snapshot {
  version: number;
  createdAt: string;
  tool: "claudedeck";
  /** Relative path -> file content (settings files already redacted). */
  files: Record<string, string>;
  /** JSON paths (e.g. `settings.json:env.ANTHROPIC_API_KEY`) removed on export. */
  redactions: string[];
}

/**
 * Recursively strip sensitive keys from a parsed JSON value.
 * Returns the sanitized value and appends removed paths to `redactions`.
 */
export function redactObject(value: unknown, pathPrefix: string, redactions: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((v, i) => redactObject(v, `${pathPrefix}[${i}]`, redactions));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (SENSITIVE_KEY_RE.test(key)) {
        redactions.push(childPath);
        continue;
      }
      out[key] = redactObject(v, childPath, redactions);
    }
    return out;
  }
  if (typeof value === "string" && ANTHROPIC_KEY_RE.test(value)) {
    redactions.push(pathPrefix);
    return value.replace(ANTHROPIC_KEY_RE_ALL, REDACTED);
  }
  return value;
}

/** Redact a settings JSON string; falls back to raw string scrubbing if unparseable. */
export function redactSettingsContent(content: string, fileLabel: string, redactions: string[]): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    const localRedactions: string[] = [];
    const sanitized = redactObject(parsed, "", localRedactions);
    redactions.push(...localRedactions.map((p) => `${fileLabel}:${p}`));
    return JSON.stringify(sanitized, null, 2) + "\n";
  } catch {
    if (ANTHROPIC_KEY_RE.test(content)) redactions.push(`${fileLabel}:<raw>`);
    return content.replace(ANTHROPIC_KEY_RE_ALL, REDACTED);
  }
}

async function collectFiles(root: string, rel: string, into: Map<string, string>): Promise<void> {
  const abs = path.join(root, rel);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(abs)).sort()) {
      await collectFiles(root, path.join(rel, name), into);
    }
  } else if (stat.isFile()) {
    into.set(rel.split(path.sep).join("/"), await fs.readFile(abs, "utf8"));
  }
}

export interface ExportOptions {
  /** Keep secrets in the snapshot (NOT recommended). Default false. */
  includeSecrets?: boolean;
}

/** Build a snapshot object from a Claude home directory. */
export async function createSnapshot(claudeHome: string, opts: ExportOptions = {}): Promise<Snapshot> {
  const files = new Map<string, string>();
  for (const dir of SNAPSHOT_DIRS) await collectFiles(claudeHome, dir, files);
  for (const file of SNAPSHOT_FILES) await collectFiles(claudeHome, file, files);

  const redactions: string[] = [];
  const out: Record<string, string> = {};
  for (const [rel, content] of files) {
    if (!opts.includeSecrets && rel.endsWith(".json")) {
      out[rel] = redactSettingsContent(content, rel, redactions);
    } else if (!opts.includeSecrets && ANTHROPIC_KEY_RE.test(content)) {
      redactions.push(`${rel}:<raw>`);
      out[rel] = content.replace(ANTHROPIC_KEY_RE_ALL, REDACTED);
    } else {
      out[rel] = content;
    }
  }

  return {
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    tool: "claudedeck",
    files: out,
    redactions,
  };
}

/** Serialize and write a snapshot to disk. */
export async function exportSnapshot(claudeHome: string, outFile: string, opts: ExportOptions = {}): Promise<Snapshot> {
  const snapshot = await createSnapshot(claudeHome, opts);
  await fs.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  return snapshot;
}

export interface ImportOptions {
  /** Overwrite files that already exist in the target. Default false. */
  force?: boolean;
}

export interface ImportResult {
  written: string[];
  skipped: string[];
  redactions: string[];
}

/** Validate and parse a snapshot file. */
export async function readSnapshot(file: string): Promise<Snapshot> {
  const content = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(content) as Partial<Snapshot>;
  if (parsed.tool !== "claudedeck" || typeof parsed.version !== "number" || typeof parsed.files !== "object" || parsed.files === null) {
    throw new Error(`${file} is not a claudedeck snapshot`);
  }
  if (parsed.version > SNAPSHOT_VERSION) {
    throw new Error(`snapshot version ${parsed.version} is newer than this claudedeck understands (${SNAPSHOT_VERSION})`);
  }
  return parsed as Snapshot;
}

/** Apply a snapshot to a target Claude home directory. */
export async function importSnapshot(file: string, targetHome: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const snapshot = await readSnapshot(file);
  const result: ImportResult = { written: [], skipped: [], redactions: snapshot.redactions ?? [] };
  const targetRoot = path.resolve(targetHome);

  for (const [rel, content] of Object.entries(snapshot.files)) {
    const abs = path.resolve(targetRoot, rel);
    // Refuse path traversal out of the target directory.
    if (abs !== targetRoot && !abs.startsWith(targetRoot + path.sep)) {
      result.skipped.push(rel);
      continue;
    }
    let exists = true;
    try {
      await fs.stat(abs);
    } catch {
      exists = false;
    }
    if (exists && !opts.force) {
      result.skipped.push(rel);
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    result.written.push(rel);
  }
  return result;
}
