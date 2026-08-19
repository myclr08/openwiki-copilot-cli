import type { OpenWikiProvider } from "../config/constants.js";

/**
 * Mutable run facts that resolve as a run proceeds, enriched in place by
 * `runOpenWikiAgent` and read by the CLI once the run settles.
 *
 * This fork sends no telemetry, so nothing here leaves the process. The context
 * survives because the facts it carries are only knowable inside the agent —
 * which provider resolution actually picked, and whether the run short-circuited
 * as a no-op — while the caller that reports them sits outside it.
 */
export interface RunTelemetryContext {
  /**
   * The resolved LLM provider, published the instant provider resolution
   * succeeds so a failure later in the run is still attributed to the right
   * provider.
   *
   * @default undefined - resolution never reached the provider.
   */
  provider?: OpenWikiProvider;

  /**
   * The non-failure outcome the run reached, set by the agent. Only a `noop`
   * short-circuit needs to be published here.
   *
   * @default undefined - the run returned without short-circuiting.
   */
  outcome?: "success" | "noop";
}
