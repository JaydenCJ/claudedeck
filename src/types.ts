/**
 * Shared domain types for claudedeck.
 *
 * The vocabulary here mirrors the on-disk format of Claude Code session logs
 * (`~/.claude/projects/<encoded-project>/<session-id>.jsonl`) plus the
 * aggregated views claudedeck computes on top of them.
 */

/** Token usage attached to a single assistant turn. */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache (billed at a premium). */
  cacheCreationTokens: number;
  /** Tokens served from the prompt cache (billed at a discount). */
  cacheReadTokens: number;
}

/** A single tool invocation found inside an assistant message. */
export interface ToolUseRef {
  /** Raw tool name, e.g. `Bash`, `Read`, or `mcp__github__list_issues`. */
  name: string;
  /** MCP server name when the tool is `mcp__<server>__<tool>`, else undefined. */
  mcpServer?: string;
  /** For `Task` tool calls: the requested subagent type. */
  subagentType?: string;
}

/** One parsed, normalized line of a Claude Code session log. */
export interface LogEntry {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  /** Human-readable project identifier (derived from `cwd`, falling back to the directory name). */
  project: string;
  timestamp: Date;
  role: "user" | "assistant";
  /** Model id for assistant turns, e.g. `claude-opus-4-8`. */
  model?: string;
  usage?: UsageTokens;
  /** True when this entry belongs to a subagent sidechain. */
  isSidechain: boolean;
  /**
   * Resolved subagent type for sidechain entries (e.g. `code-reviewer`).
   * `"(unknown-subagent)"` when the sidechain could not be matched to a Task call.
   */
  subagentType?: string;
  toolUses: ToolUseRef[];
  /** Pre-computed cost recorded by Claude Code itself, when present in the log. */
  reportedCostUsd?: number;
}

/** Per-model pricing in USD per million tokens. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

/** Pricing table keyed by model-id prefix (longest prefix wins). */
export type PricingTable = Record<string, ModelPricing>;

/** Aggregation dimensions supported by the cost engine. */
export type Dimension = "project" | "date" | "model" | "subagent" | "mcp";

/** One aggregated row (e.g. one project, one day, one MCP server). */
export interface AggregateRow {
  key: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Number of assistant turns attributed to this row. */
  turns: number;
  /** For the `mcp` dimension: number of tool calls to this server. */
  toolCalls?: number;
}

/** Overall totals across a set of entries. */
export interface Totals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turns: number;
  sessions: number;
  projects: number;
  firstTimestamp?: Date;
  lastTimestamp?: Date;
}

/** A parsed agent / command / skill definition from `~/.claude`. */
export interface AssetInfo {
  kind: "agent" | "command" | "skill";
  name: string;
  description?: string;
  /** Frontmatter fields verbatim (tools, model, allowed-tools, ...). */
  meta: Record<string, string>;
  filePath: string;
  /**
   * False when the asset file carries the `.disabled` suffix claudedeck uses
   * to park assets Claude Code should ignore (`claudedeck skills disable`).
   */
  enabled: boolean;
}

/** A single configured hook. */
export interface HookInfo {
  event: string;
  matcher?: string;
  type: string;
  command?: string;
  timeout?: number;
  /** Which settings file declared this hook. */
  source: string;
  /**
   * False when the hook lives in the settings file's `disabledHooks` section —
   * a claudedeck-managed mirror of `hooks` that Claude Code ignores
   * (`claudedeck hooks disable`).
   */
  enabled: boolean;
}

/** Structured view of a Claude Code configuration directory. */
export interface ConfigInspection {
  agents: AssetInfo[];
  commands: AssetInfo[];
  skills: AssetInfo[];
  hooks: HookInfo[];
  mcpServers: { name: string; command?: string; url?: string; source: string }[];
  settingsFiles: string[];
}
