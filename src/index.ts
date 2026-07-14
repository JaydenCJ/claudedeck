/**
 * claudedeck public API.
 *
 * The CLI (`src/cli.ts`) is a thin layer over these modules; everything here
 * can also be used as a library, e.g. to embed cost attribution into other
 * tooling.
 */

export * from "./types.js";
export {
  parseSessionContent,
  parseSessionFile,
  loadAllEntries,
  mcpServerOf,
  decodeProjectDirName,
  UNKNOWN_SUBAGENT,
} from "./parser/jsonl.js";
export {
  DEFAULT_PRICING,
  resolvePricing,
  costOf,
  costOfTurn,
  loadPricingTable,
  validatePricingTable,
} from "./pricing/pricing.js";
export { aggregate, totals, filterEntries, projectKey, MAIN_CHAIN, NO_MCP } from "./engine/aggregate.js";
export type { AggregateOptions } from "./engine/aggregate.js";
export { inspectConfig, parseFrontmatter, DISABLED_SUFFIX } from "./config/inspect.js";
export type { InspectOptions } from "./config/inspect.js";
export {
  assetPath,
  createAsset,
  findAssetByName,
  setAssetEnabled,
  setHookEnabled,
} from "./config/edit.js";
export type { HookRef } from "./config/edit.js";
export {
  createSnapshot,
  exportSnapshot,
  importSnapshot,
  readSnapshot,
  redactObject,
  redactSettingsContent,
  SNAPSHOT_VERSION,
} from "./sync/snapshot.js";
export type { Snapshot, ExportOptions, ImportOptions, ImportResult } from "./sync/snapshot.js";
export { createDashboardServer, startDashboard } from "./server/serve.js";
export type { ServeOptions } from "./server/serve.js";
