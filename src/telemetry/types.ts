/**
 * Closed set of failure families, the big bucket a failure falls in. A raw error
 * string never becomes a family; classification only ever yields one of these
 * enum values. Each family pairs with an `errorDetail` (the specific failure
 * inside it) and derives an `errorOwner` (whose problem it is). `agent_error` is
 * the residual for any failure that matched no rule (including a thrown
 * non-`Error`); it is the quality meter and should trend toward zero.
 *
 * The full taxonomy (families, per-family detail allowlists, and owner rules) lives
 * in `taxonomy.ts`.
 */
export type TelemetryErrorClass =
  | "config_error"
  | "filesystem_error"
  | "provider_error"
  | "network_error"
  | "context_limit_error"
  | "build_error"
  | "connector_error"
  | "okf_error"
  | "checkpointer_error"
  | "tool_error"
  | "output_error"
  | "agent_error"
  | "aborted";

/**
 * Who owns the fix for a failure, derived from its class, detail, and stage (see
 * `deriveOwner` in `taxonomy.ts`). It exists so a failure can be summarized by
 * who has to act, including the cross-owner exceptions: a `provider_error` with
 * detail `auth` is really the user's key, so it owns to `environment`.
 *
 * - `environment`: the user's setup, credentials, or machine.
 * - `provider`: the provider API failed transiently; retry/backoff.
 * - `openwiki`: we own the fix, whether a bug or work like chunking.
 * - `unowned`: the agent/model core failed in a way we have not named yet.
 * - `control`: the run was cancelled; excluded from failure-rate math.
 */
export type TelemetryErrorOwner =
  "environment" | "provider" | "openwiki" | "unowned" | "control";

/**
 * Ordered pipeline stage a failure was tagged at: config -> build -> run ->
 * finalize. Lets a failure be read as "where in the run did it break", so a class
 * can be located to a phase. An untagged failure carries no stage (the field is
 * omitted), which reads as "not instrumented here" rather than a named bucket.
 */
export type TelemetryErrorStage = "config" | "build" | "run" | "finalize";

/**
 * Which brain a run targeted.
 */
export type TelemetryMode = "code" | "personal";
