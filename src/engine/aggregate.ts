/**
 * Cost attribution engine.
 *
 * Aggregates parsed log entries along five dimensions: project, date, model,
 * subagent, and MCP server.
 *
 * Attribution model
 * -----------------
 * - Cost is computed per assistant turn from its usage counters and the
 *   pricing table (a `costUSD` recorded in the log wins when present).
 * - `project` / `date` / `model` attribute each turn to exactly one bucket.
 * - `subagent` attributes sidechain turns to their resolved subagent type;
 *   main-chain turns fall into the `(main)` bucket.
 * - `mcp` attributes a turn's cost to the MCP server(s) whose tools it
 *   invokes, split evenly among distinct servers within the turn. Turns that
 *   invoke no MCP tools fall into `(no-mcp)`. This "direct invocation"
 *   attribution is an approximation — token usage is billed per turn, not per
 *   tool — but it is the fairest per-server split the logs allow, and it is
 *   what makes "this MCP server burns $40/month" measurable at all.
 */

import type {
  AggregateRow,
  Dimension,
  LogEntry,
  PricingTable,
  Totals,
  UsageTokens,
} from "../types.js";
import { costOfTurn } from "../pricing/pricing.js";

export const MAIN_CHAIN = "(main)";
export const NO_MCP = "(no-mcp)";

export interface AggregateOptions {
  pricing?: PricingTable;
  since?: Date;
  until?: Date;
  /** Restrict to a single project (matched on the normalized project key). */
  project?: string;
  onUnknownModel?: (model: string) => void;
}

const EMPTY_USAGE: UsageTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

/** Normalize a project path to a short display key (last two path segments). */
export function projectKey(project: string): string {
  const parts = project.split("/").filter(Boolean);
  if (parts.length <= 2) return project;
  return parts.slice(-2).join("/");
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function filterEntries(entries: LogEntry[], opts: AggregateOptions): LogEntry[] {
  return entries.filter((e) => {
    if (opts.since && e.timestamp < opts.since) return false;
    if (opts.until && e.timestamp > opts.until) return false;
    if (opts.project && projectKey(e.project) !== opts.project) return false;
    return true;
  });
}

function entryCost(e: LogEntry, opts: AggregateOptions): number {
  if (typeof e.reportedCostUsd === "number") return e.reportedCostUsd;
  return costOfTurn(e.model, e.usage, opts.pricing, opts.onUnknownModel);
}

interface Bucket extends AggregateRow {}

function addToBucket(buckets: Map<string, Bucket>, key: string, cost: number, usage: UsageTokens, turns: number, toolCalls?: number): void {
  let b = buckets.get(key);
  if (!b) {
    b = { key, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, turns: 0 };
    buckets.set(key, b);
  }
  b.costUsd += cost;
  b.inputTokens += usage.inputTokens;
  b.outputTokens += usage.outputTokens;
  b.cacheCreationTokens += usage.cacheCreationTokens;
  b.cacheReadTokens += usage.cacheReadTokens;
  b.turns += turns;
  if (toolCalls !== undefined) b.toolCalls = (b.toolCalls ?? 0) + toolCalls;
}

function scaleUsage(u: UsageTokens, factor: number): UsageTokens {
  return {
    inputTokens: Math.round(u.inputTokens * factor),
    outputTokens: Math.round(u.outputTokens * factor),
    cacheCreationTokens: Math.round(u.cacheCreationTokens * factor),
    cacheReadTokens: Math.round(u.cacheReadTokens * factor),
  };
}

/** Aggregate entries along one dimension; rows are sorted by cost, descending. */
export function aggregate(entries: LogEntry[], by: Dimension, opts: AggregateOptions = {}): AggregateRow[] {
  const buckets = new Map<string, Bucket>();
  const filtered = filterEntries(entries, opts);

  for (const e of filtered) {
    if (e.role !== "assistant") continue;
    const usage = e.usage ?? EMPTY_USAGE;
    const cost = entryCost(e, opts);

    switch (by) {
      case "project":
        addToBucket(buckets, projectKey(e.project), cost, usage, 1);
        break;
      case "date":
        addToBucket(buckets, dateKey(e.timestamp), cost, usage, 1);
        break;
      case "model":
        addToBucket(buckets, e.model ?? "(unknown)", cost, usage, 1);
        break;
      case "subagent":
        addToBucket(buckets, e.isSidechain ? (e.subagentType ?? MAIN_CHAIN) : MAIN_CHAIN, cost, usage, 1);
        break;
      case "mcp": {
        const servers = [...new Set(e.toolUses.map((t) => t.mcpServer).filter((s): s is string => !!s))];
        if (servers.length === 0) {
          addToBucket(buckets, NO_MCP, cost, usage, 1, 0);
        } else {
          const share = 1 / servers.length;
          for (const server of servers) {
            const calls = e.toolUses.filter((t) => t.mcpServer === server).length;
            addToBucket(buckets, server, cost * share, scaleUsage(usage, share), 1, calls);
          }
        }
        break;
      }
    }
  }

  const rows = [...buckets.values()];
  if (by === "date") rows.sort((a, b) => a.key.localeCompare(b.key));
  else rows.sort((a, b) => b.costUsd - a.costUsd);
  return rows;
}

/** Overall totals for a set of entries. */
export function totals(entries: LogEntry[], opts: AggregateOptions = {}): Totals {
  const filtered = filterEntries(entries, opts);
  const t: Totals = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    sessions: 0,
    projects: 0,
  };
  const sessions = new Set<string>();
  const projects = new Set<string>();
  for (const e of filtered) {
    sessions.add(e.sessionId);
    projects.add(projectKey(e.project));
    if (e.timestamp.getTime() > 0) {
      if (!t.firstTimestamp || e.timestamp < t.firstTimestamp) t.firstTimestamp = e.timestamp;
      if (!t.lastTimestamp || e.timestamp > t.lastTimestamp) t.lastTimestamp = e.timestamp;
    }
    if (e.role !== "assistant") continue;
    const usage = e.usage ?? EMPTY_USAGE;
    t.costUsd += entryCost(e, opts);
    t.inputTokens += usage.inputTokens;
    t.outputTokens += usage.outputTokens;
    t.cacheCreationTokens += usage.cacheCreationTokens;
    t.cacheReadTokens += usage.cacheReadTokens;
    t.turns += 1;
  }
  t.sessions = sessions.size;
  t.projects = projects.size;
  return t;
}
