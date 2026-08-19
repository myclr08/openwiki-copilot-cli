/**
 * Run error classification.
 *
 * This fork removed OpenWiki's telemetry: nothing here sends, stores, or
 * identifies anything, and there is no analytics dependency left in the tree.
 * What remains is the error taxonomy the CLI uses locally to explain a failure —
 * which stage it happened in, which layer owns it, and what kind of failure it
 * was — which is why the module keeps its place in the run's control flow.
 */
export type { RunTelemetryContext } from "./run-context.js";
export {
  classifyError,
  describeErrorForTelemetry,
  inStage,
  inStageSync,
  tagErrorStage,
} from "./errors.js";
export type {
  ErrorClassification,
  ErrorOrigin,
  ErrorTelemetry,
} from "./errors.js";
export { deriveOwner, normalizeErrorDetail } from "./taxonomy.js";
export type {
  TelemetryErrorClass,
  TelemetryErrorOwner,
  TelemetryErrorStage,
  TelemetryMode,
} from "./types.js";
