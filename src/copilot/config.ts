/**
 * Environment knobs for the Copilot CLI backend.
 *
 * These live beside the backend rather than in the provider registry because
 * they configure a local process, not a hosted endpoint.
 */

/** Overrides the `copilot` executable, mainly so tests can supply a stub. */
export const COPILOT_CLI_BIN_ENV_KEY = "OPENWIKI_COPILOT_CLI_BIN";

/** Per-repository wall-clock budget for one Copilot run, in milliseconds. */
export const COPILOT_TIMEOUT_ENV_KEY = "OPENWIKI_COPILOT_TIMEOUT_MS";

/** Set to "1" to leave Copilot's built-in GitHub MCP server enabled. */
export const COPILOT_GITHUB_MCP_ENV_KEY = "OPENWIKI_COPILOT_GITHUB_MCP";

/** Directory name holding each repository's wiki inside the wiki root. */
export const REPOS_DIRECTORY = "repos";

/** Default wiki directory created inside the workspace folder. */
export const DEFAULT_WIKI_DIRECTORY = "openwiki";

/** Default model, used when neither the CLI nor the environment picks one. */
export const DEFAULT_COPILOT_CLI_MODEL = "claude-sonnet-4.6";

/** Default per-repository timeout: documentation runs are long. */
export const DEFAULT_COPILOT_TIMEOUT_MS = 60 * 60 * 1000;

/** Resolves the Copilot executable to spawn. */
export function resolveCopilotBinary(env = process.env): string {
  return env[COPILOT_CLI_BIN_ENV_KEY]?.trim() || "copilot";
}

/**
 * Resolves the per-repository timeout. An unparseable or non-positive value
 * falls back to the default rather than failing the run, so a typo cannot make
 * every repository time out instantly.
 */
export function resolveCopilotTimeoutMs(env = process.env): number {
  const raw = env[COPILOT_TIMEOUT_ENV_KEY]?.trim();

  if (!raw) return DEFAULT_COPILOT_TIMEOUT_MS;

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_COPILOT_TIMEOUT_MS;
}

/**
 * Whether Copilot's built-in GitHub MCP server stays enabled. It is off by
 * default: documenting local repositories needs no network tools, and leaving
 * it on adds startup cost and non-determinism.
 */
export function githubMcpEnabled(env = process.env): boolean {
  return env[COPILOT_GITHUB_MCP_ENV_KEY]?.trim() === "1";
}
