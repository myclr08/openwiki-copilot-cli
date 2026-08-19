import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { COPILOT_CLI_BIN_ENV_KEY, resolveCopilotBinary } from "./config.js";

const execFileAsync = promisify(execFile);

/** How long the version preflight may take before it is treated as a failure. */
const PREFLIGHT_TIMEOUT_MS = 30_000;

/** What the preflight learned about the local Copilot CLI. */
export interface CopilotAvailability {
  /** The executable that was probed. */
  binary: string;

  /** Raw `--version` output, trimmed. */
  version: string;
}

/**
 * Verifies that a runnable Copilot CLI exists before any repository is touched.
 *
 * Failing here is much cheaper than failing halfway through a workspace, and
 * the message names the fix rather than surfacing a raw ENOENT.
 */
export async function ensureCopilotAvailable(
  env = process.env,
): Promise<CopilotAvailability> {
  const binary = resolveCopilotBinary(env);

  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      env,
      timeout: PREFLIGHT_TIMEOUT_MS,
    });

    return { binary, version: stdout.trim() };
  } catch (error) {
    throw new Error(formatUnavailableMessage(binary, error), { cause: error });
  }
}

/** Builds an actionable message for a Copilot CLI that could not be run. */
function formatUnavailableMessage(binary: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  if (code === "ENOENT") {
    return [
      `GitHub Copilot CLI was not found (tried "${binary}").`,
      "Install it with `npm install -g @github/copilot`, or set",
      `${COPILOT_CLI_BIN_ENV_KEY} to the executable's path.`,
    ].join(" ");
  }

  const detail = error instanceof Error ? error.message : String(error);

  return [
    `GitHub Copilot CLI could not be started ("${binary} --version" failed).`,
    "Check the install and run `copilot login` if you have not signed in.",
    `Details: ${detail}`,
  ].join(" ");
}
