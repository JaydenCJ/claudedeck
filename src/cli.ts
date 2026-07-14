#!/usr/bin/env node
/**
 * claudedeck CLI — the local-first control deck for Claude Code.
 *
 * Subcommands: stats · top · skills · hooks · sync export/import · serve
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { Command } from "commander";
import { loadAllEntries } from "./parser/jsonl.js";
import { aggregate, totals, NO_MCP } from "./engine/aggregate.js";
import { DEFAULT_PRICING, loadPricingTable } from "./pricing/pricing.js";
import { inspectConfig } from "./config/inspect.js";
import { createAsset, findAssetByName, setAssetEnabled, setHookEnabled } from "./config/edit.js";
import { exportSnapshot, importSnapshot } from "./sync/snapshot.js";
import { startDashboard } from "./server/serve.js";
import { bar, fmtTokens, fmtUsd, renderTable } from "./util/format.js";
import type { AssetInfo, Dimension, PricingTable } from "./types.js";
import type { AggregateOptions } from "./engine/aggregate.js";

// Single source of truth for the version: the compiled CLI lives in dist/, so
// package.json is one directory up both in the repo and in the npm package.
const VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
const DIMENSIONS: Dimension[] = ["project", "date", "model", "subagent", "mcp"];

interface GlobalOpts {
  dir: string;
  pricing?: string;
  json?: boolean;
  since?: string;
  until?: string;
}

function defaultClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

function parseDate(value: string | undefined, flag: string): Date | undefined {
  if (!value) return undefined;
  // A bare date for --until means "through the end of that day": parsing
  // 2026-07-01 as midnight would silently exclude July 1st itself.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(dateOnly && flag === "--until" ? `${value}T23:59:59.999Z` : value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid date for ${flag}: "${value}" (expected e.g. 2026-07-01)`);
  }
  return d;
}

async function buildContext(opts: GlobalOpts): Promise<{
  claudeHome: string;
  pricing: PricingTable;
  aggOpts: AggregateOptions;
  unknownModels: Set<string>;
}> {
  const claudeHome = path.resolve(opts.dir);
  const defaultOverride = path.join(claudeHome, "claudedeck.pricing.json");
  // An explicitly passed --pricing path must exist; the implicit default may not.
  const pricing = await loadPricingTable(opts.pricing ?? defaultOverride, {
    required: opts.pricing !== undefined,
  });
  const unknownModels = new Set<string>();
  const aggOpts: AggregateOptions = {
    pricing,
    since: parseDate(opts.since, "--since"),
    until: parseDate(opts.until, "--until"),
    onUnknownModel: (m: string) => unknownModels.add(m),
  };
  return { claudeHome, pricing, aggOpts, unknownModels };
}

/** Warn when the data directory has no `projects/` tree — a typo'd --dir would otherwise render an all-zero report. */
async function warnIfNoData(claudeHome: string): Promise<void> {
  try {
    await fs.stat(path.join(claudeHome, "projects"));
  } catch {
    process.stderr.write(
      `warning: no session logs found — ${path.join(claudeHome, "projects")} does not exist. ` +
        `Check --dir / CLAUDE_CONFIG_DIR if this is unexpected.\n`,
    );
  }
}

function warnUnknown(unknownModels: Set<string>): void {
  if (unknownModels.size > 0) {
    process.stderr.write(
      `warning: no pricing for model(s) ${[...unknownModels].join(", ")} — counted as $0. ` +
        `Add them to claudedeck.pricing.json to include them.\n`,
    );
  }
}

const program = new Command();

program
  .name("claudedeck")
  .description("Local-first control deck for Claude Code: cost attribution, skills/hooks editing, config sync.")
  .version(VERSION)
  .option("-d, --dir <path>", "Claude Code config directory", defaultClaudeHome())
  .option("--pricing <file>", "pricing override JSON (defaults to <dir>/claudedeck.pricing.json when present)")
  .option("--json", "machine-readable JSON output");

program
  .command("stats")
  .description("overall usage & cost summary with per-model and per-project breakdowns")
  .option("--since <date>", "only include entries at/after this date")
  .option("--until <date>", "only include entries at/before this date (a bare date includes that whole day)")
  .action(async (cmdOpts: { since?: string; until?: string }) => {
    const opts = { ...program.opts<GlobalOpts>(), ...cmdOpts };
    const { claudeHome, aggOpts, unknownModels } = await buildContext(opts);
    await warnIfNoData(claudeHome);
    const entries = await loadAllEntries(claudeHome);
    const t = totals(entries, aggOpts);
    const byModel = aggregate(entries, "model", aggOpts);
    const byProject = aggregate(entries, "project", aggOpts);

    if (opts.json) {
      process.stdout.write(JSON.stringify({ totals: t, byModel, byProject }, null, 2) + "\n");
      return;
    }

    const range =
      t.firstTimestamp && t.lastTimestamp
        ? `${t.firstTimestamp.toISOString().slice(0, 10)} → ${t.lastTimestamp.toISOString().slice(0, 10)}`
        : "n/a";
    console.log(`claudedeck stats — ${claudeHome}`);
    console.log(`  range     ${range}`);
    console.log(`  cost      ${fmtUsd(t.costUsd)}`);
    console.log(`  turns     ${t.turns}  (${t.sessions} sessions, ${t.projects} projects)`);
    console.log(`  input     ${fmtTokens(t.inputTokens)}   output ${fmtTokens(t.outputTokens)}`);
    console.log(`  cache     write ${fmtTokens(t.cacheCreationTokens)}   read ${fmtTokens(t.cacheReadTokens)}`);
    console.log("");
    console.log("By model:");
    console.log(
      renderTable(
        ["model", "cost", "in", "out", "turns"],
        byModel.map((r) => [r.key, fmtUsd(r.costUsd), fmtTokens(r.inputTokens), fmtTokens(r.outputTokens), String(r.turns)]),
      ),
    );
    console.log("");
    console.log("By project:");
    console.log(
      renderTable(
        ["project", "cost", "turns"],
        byProject.map((r) => [r.key, fmtUsd(r.costUsd), String(r.turns)]),
      ),
    );
    warnUnknown(unknownModels);
  });

program
  .command("top")
  .description("rank cost along a dimension: project | date | model | subagent | mcp")
  .option("-b, --by <dimension>", "dimension to rank by", "project")
  .option("-n, --limit <n>", "max rows", "10")
  .option("--since <date>", "only include entries at/after this date")
  .option("--until <date>", "only include entries at/before this date (a bare date includes that whole day)")
  .action(async (cmdOpts: { by: string; limit: string; since?: string; until?: string }) => {
    const opts = { ...program.opts<GlobalOpts>(), ...cmdOpts };
    if (!DIMENSIONS.includes(cmdOpts.by as Dimension)) {
      throw new Error(`--by must be one of: ${DIMENSIONS.join(", ")}`);
    }
    const by = cmdOpts.by as Dimension;
    const limit = Math.max(1, Number(cmdOpts.limit) || 10);
    const { claudeHome, aggOpts, unknownModels } = await buildContext(opts);
    await warnIfNoData(claudeHome);
    const entries = await loadAllEntries(claudeHome);
    let rows = aggregate(entries, by, aggOpts);
    if (by === "mcp") rows = rows.filter((r) => r.key !== NO_MCP);
    rows = rows.slice(0, limit);

    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      return;
    }
    if (rows.length === 0) {
      console.log(`No ${by === "mcp" ? "MCP tool usage" : "data"} found in ${claudeHome}.`);
      return;
    }
    const max = Math.max(...rows.map((r) => r.costUsd));
    console.log(`Top ${by} by cost — ${claudeHome}`);
    console.log(
      renderTable(
        [by, "", "cost", ...(by === "mcp" ? ["calls"] : []), "turns"],
        rows.map((r) => [
          r.key,
          bar(r.costUsd, max),
          fmtUsd(r.costUsd),
          ...(by === "mcp" ? [String(r.toolCalls ?? 0)] : []),
          String(r.turns),
        ]),
      ),
    );
    warnUnknown(unknownModels);
  });

const ASSET_KINDS: AssetInfo["kind"][] = ["skill", "agent", "command"];

function parseKind(value: string | undefined): AssetInfo["kind"] | undefined {
  if (value === undefined) return undefined;
  if (!ASSET_KINDS.includes(value as AssetInfo["kind"])) {
    throw new Error(`--kind must be one of: ${ASSET_KINDS.join(", ")}`);
  }
  return value as AssetInfo["kind"];
}

async function toggleAssetByName(name: string, kindFlag: string | undefined, enabled: boolean): Promise<void> {
  const opts = program.opts<GlobalOpts>();
  const { claudeHome } = await buildContext(opts);
  const cfg = await inspectConfig(claudeHome, { projectDir: process.cwd() });
  const asset = findAssetByName(cfg, name, parseKind(kindFlag));
  const result = await setAssetEnabled(asset.filePath, enabled);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { kind: asset.kind, name: asset.name, enabled, changed: result.changed, filePath: result.filePath },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (!result.changed) {
    console.log(`${asset.kind} "${asset.name}" is already ${enabled ? "enabled" : "disabled"} — nothing to do.`);
    return;
  }
  console.log(`${enabled ? "Enabled" : "Disabled"} ${asset.kind} "${asset.name}" → ${result.filePath}`);
}

const skills = program
  .command("skills")
  .description("list, create, enable and disable skills, agents and slash commands");

skills
  .command("list", { isDefault: true })
  .description("list skills, agents and slash commands")
  .action(async () => {
    const opts = program.opts<GlobalOpts>();
    const { claudeHome } = await buildContext(opts);
    const cfg = await inspectConfig(claudeHome, { projectDir: process.cwd() });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ skills: cfg.skills, agents: cfg.agents, commands: cfg.commands }, null, 2) + "\n");
      return;
    }
    for (const [title, items] of [
      ["Skills", cfg.skills],
      ["Agents", cfg.agents],
      ["Commands", cfg.commands],
    ] as const) {
      console.log(`${title} (${items.length}):`);
      if (items.length === 0) console.log("  (none)");
      for (const a of items) {
        const state = a.enabled ? "" : " [disabled]";
        console.log(`  ${a.name}${state}${a.description ? ` — ${a.description}` : ""}`);
      }
      console.log("");
    }
  });

skills
  .command("enable <name>")
  .description("re-enable a disabled skill/agent/command (removes the .disabled suffix)")
  .option("-k, --kind <kind>", "disambiguate: skill | agent | command")
  .action(async (name: string, cmdOpts: { kind?: string }) => {
    await toggleAssetByName(name, cmdOpts.kind, true);
  });

skills
  .command("disable <name>")
  .description("disable a skill/agent/command without deleting it (renames to .disabled)")
  .option("-k, --kind <kind>", "disambiguate: skill | agent | command")
  .action(async (name: string, cmdOpts: { kind?: string }) => {
    await toggleAssetByName(name, cmdOpts.kind, false);
  });

skills
  .command("new <kind> <name>")
  .description("create a skill/agent/command from a starter template (kind: skill | agent | command)")
  .action(async (kind: string, name: string) => {
    const opts = program.opts<GlobalOpts>();
    const { claudeHome } = await buildContext(opts);
    const parsedKind = parseKind(kind);
    if (!parsedKind) throw new Error(`kind must be one of: ${ASSET_KINDS.join(", ")}`);
    const filePath = await createAsset(claudeHome, parsedKind, name);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ kind: parsedKind, name, filePath }, null, 2) + "\n");
      return;
    }
    console.log(`Created ${parsedKind} "${name}" → ${filePath}`);
    console.log("Edit the file to fill in the description and body.");
  });

async function toggleHookByIndex(index: string, enabled: boolean): Promise<void> {
  const opts = program.opts<GlobalOpts>();
  const { claudeHome } = await buildContext(opts);
  const cfg = await inspectConfig(claudeHome, { projectDir: process.cwd() });
  const i = Number(index);
  if (!Number.isInteger(i) || i < 1 || i > cfg.hooks.length) {
    throw new Error(`hook index must be 1..${cfg.hooks.length} (see \`claudedeck hooks list\`)`);
  }
  const h = cfg.hooks[i - 1];
  const changed = await setHookEnabled(
    claudeHome,
    { source: h.source, event: h.event, matcher: h.matcher, command: h.command },
    enabled,
  );
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...h, enabled, changed }, null, 2) + "\n");
    return;
  }
  if (!changed) {
    console.log(`Hook #${i} (${h.event}) is already ${enabled ? "enabled" : "disabled"} — nothing to do.`);
    return;
  }
  console.log(`${enabled ? "Enabled" : "Disabled"} hook #${i}: ${h.event} → ${h.command ?? h.type} (${h.source})`);
}

const hooks = program
  .command("hooks")
  .description("list, enable and disable hooks; list MCP servers");

hooks
  .command("list", { isDefault: true })
  .description("list configured hooks and MCP servers")
  .action(async () => {
    const opts = program.opts<GlobalOpts>();
    const { claudeHome } = await buildContext(opts);
    const cfg = await inspectConfig(claudeHome, { projectDir: process.cwd() });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ hooks: cfg.hooks, mcpServers: cfg.mcpServers }, null, 2) + "\n");
      return;
    }
    console.log(`Hooks (${cfg.hooks.length}):`);
    if (cfg.hooks.length === 0) console.log("  (none)");
    else
      console.log(
        renderTable(
          ["#", "event", "matcher", "command", "state", "source"],
          cfg.hooks.map((h, i) => [
            String(i + 1),
            h.event,
            h.matcher ?? "*",
            h.command ?? h.type,
            h.enabled ? "on" : "off",
            h.source,
          ]),
        )
          .split("\n")
          .map((l) => "  " + l)
          .join("\n"),
      );
    console.log("");
    console.log(`MCP servers (${cfg.mcpServers.length}):`);
    if (cfg.mcpServers.length === 0) console.log("  (none)");
    for (const s of cfg.mcpServers) {
      console.log(`  ${s.name} — ${s.url ?? s.command ?? "?"} (${s.source})`);
    }
  });

hooks
  .command("enable <index>")
  .description("re-enable a disabled hook by its number in `claudedeck hooks list`")
  .action(async (index: string) => {
    await toggleHookByIndex(index, true);
  });

hooks
  .command("disable <index>")
  .description("disable a hook by its number in `claudedeck hooks list` (moved to disabledHooks, not deleted)")
  .action(async (index: string) => {
    await toggleHookByIndex(index, false);
  });

const sync = program.command("sync").description("export/import portable config snapshots");

sync
  .command("export")
  .description("pack settings.json, agents, commands, skills and CLAUDE.md into a snapshot (secrets stripped; settings.local.json stays machine-local)")
  .option("-o, --out <file>", "output file", "claudedeck-snapshot.json")
  .option("--include-secrets", "keep API keys and tokens in the snapshot (dangerous)")
  .action(async (cmdOpts: { out: string; includeSecrets?: boolean }) => {
    const opts = program.opts<GlobalOpts>();
    const { claudeHome } = await buildContext(opts);
    const snapshot = await exportSnapshot(claudeHome, cmdOpts.out, { includeSecrets: cmdOpts.includeSecrets });
    const fileCount = Object.keys(snapshot.files).length;
    if (opts.json) {
      process.stdout.write(JSON.stringify({ out: cmdOpts.out, files: fileCount, redactions: snapshot.redactions }, null, 2) + "\n");
      return;
    }
    console.log(`Exported ${fileCount} file(s) from ${claudeHome} to ${cmdOpts.out}`);
    if (snapshot.redactions.length > 0) {
      console.log(`Redacted ${snapshot.redactions.length} sensitive value(s):`);
      for (const r of snapshot.redactions) console.log(`  - ${r}`);
    }
  });

sync
  .command("import <file>")
  .description("apply a snapshot to a Claude Code config directory")
  .option("--target <dir>", "target directory (defaults to --dir)")
  .option("-f, --force", "overwrite existing files")
  .action(async (file: string, cmdOpts: { target?: string; force?: boolean }) => {
    const opts = program.opts<GlobalOpts>();
    const { claudeHome } = await buildContext(opts);
    const target = cmdOpts.target ? path.resolve(cmdOpts.target) : claudeHome;
    await fs.mkdir(target, { recursive: true });
    const result = await importSnapshot(file, target, { force: cmdOpts.force });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    console.log(`Imported into ${target}: ${result.written.length} written, ${result.skipped.length} skipped.`);
    for (const w of result.written) console.log(`  + ${w}`);
    for (const s of result.skipped) console.log(`  = ${s} (exists; use --force to overwrite)`);
    if (result.redactions.length > 0) {
      console.log(`Note: this snapshot had ${result.redactions.length} redacted secret(s) — re-provision them manually.`);
    }
  });

program
  .command("serve")
  .description("start the local web dashboard (binds to 127.0.0.1; zero upload)")
  .option("-p, --port <port>", "port to listen on", "7433")
  .option("--host <host>", "host to bind", "127.0.0.1")
  .action(async (cmdOpts: { port: string; host: string }) => {
    const opts = program.opts<GlobalOpts>();
    const { claudeHome, pricing } = await buildContext(opts);
    const { port } = await startDashboard({
      claudeHome,
      pricing,
      port: Number(cmdOpts.port) || 7433,
      host: cmdOpts.host,
    });
    console.log(`claudedeck dashboard → http://${cmdOpts.host}:${port}`);
    console.log(`reading from ${claudeHome} — all data stays on this machine. Ctrl+C to stop.`);
  });

program
  .command("pricing")
  .description("print the effective pricing table (defaults merged with overrides)")
  .action(async () => {
    const opts = program.opts<GlobalOpts>();
    const { pricing } = await buildContext(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(pricing, null, 2) + "\n");
      return;
    }
    console.log(
      renderTable(
        ["model prefix", "in/MTok", "out/MTok", "cache w", "cache r"],
        Object.entries(pricing).map(([model, p]) => [
          model,
          `$${p.inputPerMTok}`,
          `$${p.outputPerMTok}`,
          `$${p.cacheWritePerMTok}`,
          `$${p.cacheReadPerMTok}`,
        ]),
      ),
    );
    if (pricing === DEFAULT_PRICING) {
      console.log("\n(no override file found — using built-in defaults)");
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
