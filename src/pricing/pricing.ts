/**
 * Model pricing and per-turn cost computation.
 *
 * Prices are USD per million tokens and follow Anthropic's published API
 * pricing (cache writes ≈ 1.25× input for the default 5-minute TTL, cache
 * reads ≈ 0.1× input). The table is keyed by model-id *prefix* so dated
 * releases like `claude-sonnet-4-5-20250929` resolve without an exact entry.
 *
 * Users can override or extend the table with `~/.claude/claudedeck.pricing.json`
 * (or any file passed via `--pricing`), which is deep-merged over the defaults.
 */

import { promises as fs } from "node:fs";
import type { ModelPricing, PricingTable, UsageTokens } from "../types.js";

/** Built-in pricing table (USD per MTok). Longest matching prefix wins. */
export const DEFAULT_PRICING: PricingTable = {
  // Frontier
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 1 },
  "claude-mythos-5": { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 1 },
  // Opus 4.5+ ($5/$25 tier)
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  // Older Opus ($15/$75 tier)
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 },
  "claude-opus-4-0": { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 },
  "claude-opus-4": { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 },
  "claude-3-opus": { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 },
  // Sonnet ($3/$15 tier)
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  "claude-3-7-sonnet": { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  "claude-3-5-sonnet": { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  // Haiku
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4, cacheWritePerMTok: 1, cacheReadPerMTok: 0.08 },
  "claude-3-haiku": { inputPerMTok: 0.25, outputPerMTok: 1.25, cacheWritePerMTok: 0.3125, cacheReadPerMTok: 0.025 },
};

/** Models that carry no cost (Claude Code uses `<synthetic>` for injected turns). */
const ZERO_COST_MODELS = new Set(["<synthetic>"]);

/**
 * Resolve pricing for a model id via longest-prefix match.
 * Returns undefined for unknown models — callers decide how to surface that.
 */
export function resolvePricing(model: string, table: PricingTable = DEFAULT_PRICING): ModelPricing | undefined {
  if (ZERO_COST_MODELS.has(model)) {
    return { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 };
  }
  let best: string | undefined;
  for (const prefix of Object.keys(table)) {
    if (model.startsWith(prefix) && (best === undefined || prefix.length > best.length)) {
      best = prefix;
    }
  }
  return best !== undefined ? table[best] : undefined;
}

/** Compute the USD cost of one turn's token usage under the given pricing. */
export function costOf(usage: UsageTokens, pricing: ModelPricing): number {
  return (
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheCreationTokens * pricing.cacheWritePerMTok +
      usage.cacheReadTokens * pricing.cacheReadPerMTok) /
    1_000_000
  );
}

/**
 * Cost of one turn for a given model id. Unknown models cost 0 and are
 * reported through the optional `onUnknownModel` callback so the CLI can warn.
 */
export function costOfTurn(
  model: string | undefined,
  usage: UsageTokens | undefined,
  table: PricingTable = DEFAULT_PRICING,
  onUnknownModel?: (model: string) => void,
): number {
  if (!model || !usage) return 0;
  const pricing = resolvePricing(model, table);
  if (!pricing) {
    onUnknownModel?.(model);
    return 0;
  }
  return costOf(usage, pricing);
}

/**
 * Load a user pricing override file (JSON matching {@link PricingTable}) and
 * merge it over the defaults. Malformed file → throw. A missing file falls
 * back to the defaults — unless `required` is set (used when the user passed
 * `--pricing` explicitly, where silently ignoring a typo'd path would be a
 * trap), in which case it throws.
 */
export async function loadPricingTable(
  overridePath?: string,
  opts: { required?: boolean } = {},
): Promise<PricingTable> {
  if (!overridePath) return DEFAULT_PRICING;
  let content: string;
  try {
    content = await fs.readFile(overridePath, "utf8");
  } catch (err) {
    if (opts.required) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot read pricing file ${overridePath}: ${reason}`);
    }
    return DEFAULT_PRICING;
  }
  const parsed = JSON.parse(content) as PricingTable;
  validatePricingTable(parsed);
  return { ...DEFAULT_PRICING, ...parsed };
}

/** Throw a descriptive error if a user-supplied table has the wrong shape. */
export function validatePricingTable(table: unknown): asserts table is PricingTable {
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new Error("pricing override must be a JSON object keyed by model prefix");
  }
  for (const [model, p] of Object.entries(table as Record<string, unknown>)) {
    const entry = p as Partial<ModelPricing> | null;
    for (const field of ["inputPerMTok", "outputPerMTok", "cacheWritePerMTok", "cacheReadPerMTok"] as const) {
      if (typeof entry?.[field] !== "number" || entry[field]! < 0) {
        throw new Error(`pricing override for "${model}" is missing a non-negative numeric "${field}"`);
      }
    }
  }
}
