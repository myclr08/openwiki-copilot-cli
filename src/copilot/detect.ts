import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { COPILOT_CLI_BIN_ENV_KEY, resolveCopilotBinary } from "./config.js";

const execFileAsync = promisify(execFile);

/** How long the version preflight may take before it is treated as a failure. */
const PREFLIGHT_TIMEOUT_MS = 30_000;

/**
 * A concrete way to start Copilot CLI: the executable to spawn plus any
 * arguments that must precede Copilot's own.
 *
 * This exists because `copilot` on PATH is not always something a process can
 * execute. A global npm install puts shims there — `copilot.cmd` and a
 * extension-less shell script on Windows — and Node refuses to spawn a `.cmd`
 * without a shell (the fix for CVE-2024-27980), which surfaces as `EINVAL`.
 * Running it through a shell is not an option either: the prompt is a long
 * multi-line document, and `cmd.exe` would tear it apart at the newlines. So
 * the shim is resolved to something directly spawnable instead.
 */
export interface CopilotLauncher {
  /** Executable to spawn. */
  command: string;

  /** Arguments inserted before Copilot's own arguments. */
  prefixArgs: string[];
}

/** What the preflight learned about the local Copilot CLI. */
export interface CopilotAvailability {
  /** The launcher that answered, to be reused for every run. */
  launcher: CopilotLauncher;

  /** Raw `--version` output, trimmed. */
  version: string;
}

/**
 * Verifies that a runnable Copilot CLI exists before any repository is touched,
 * and returns the launcher that worked.
 *
 * Candidates are tried in order: the configured path as given, then the
 * platform executable inside the npm package, then the package's Node loader.
 * The first one whose `--version` answers wins. Failing here is much cheaper
 * than failing halfway through a workspace, and the message names the fix
 * rather than surfacing a raw ENOENT or EINVAL.
 */
export async function ensureCopilotAvailable(
  env = process.env,
): Promise<CopilotAvailability> {
  const binary = resolveCopilotBinary(env);
  const candidates = await resolveCopilotLaunchers(binary);
  let lastError: unknown;

  for (const launcher of candidates) {
    try {
      const { stdout } = await execFileAsync(
        launcher.command,
        [...launcher.prefixArgs, "--version"],
        { env, timeout: PREFLIGHT_TIMEOUT_MS },
      );

      return { launcher, version: stdout.trim() };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(formatUnavailableMessage(binary, lastError), {
    cause: lastError,
  });
}

/**
 * Lists the ways this Copilot CLI install might be started, best first.
 *
 * The npm package (`@github/copilot`) is a Node loader that spawns a platform
 * executable shipped in a sibling package (`@github/copilot-win32-x64` and
 * friends). Both are reachable from the shim's directory, so a shim that cannot
 * be spawned still leads to something that can — the executable directly, which
 * is preferred because it keeps the process tree flat and lets a timeout kill
 * the real process rather than a wrapper.
 */
export async function resolveCopilotLaunchers(
  binary: string,
): Promise<CopilotLauncher[]> {
  const launchers: CopilotLauncher[] = [{ command: binary, prefixArgs: [] }];

  for (const root of nodeModulesRoots(binary)) {
    const platformExecutable = await resolvePackageBin(
      path.join(root, "@github", `copilot-${process.platform}-${process.arch}`),
    );

    if (platformExecutable) {
      launchers.push({ command: platformExecutable, prefixArgs: [] });
    }

    const loader = await resolvePackageBin(
      path.join(root, "@github", "copilot"),
    );

    if (loader) {
      launchers.push({
        command: process.execPath,
        prefixArgs: [loader],
      });
    }
  }

  return launchers;
}

/**
 * Directories that could hold the Copilot packages, derived from where the
 * shim sits: beside it (the npm global directory on Windows) or under the
 * install prefix (`<prefix>/bin/copilot` with `<prefix>/lib/node_modules`).
 */
function nodeModulesRoots(binary: string): string[] {
  const binDir = path.dirname(path.resolve(binary));
  const prefix = path.dirname(binDir);

  return [
    path.join(binDir, "node_modules"),
    path.join(prefix, "lib", "node_modules"),
    path.join(prefix, "node_modules"),
  ];
}

/**
 * Resolves a package's executable from its manifest, or undefined when the
 * package is absent or names a file that is not there.
 *
 * The `bin` field is read rather than assuming a filename, so a rename in a
 * future Copilot release does not silently break the fallback.
 */
async function resolvePackageBin(
  packageDir: string,
): Promise<string | undefined> {
  let manifest: { bin?: Record<string, string> | string };

  try {
    manifest = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    ) as typeof manifest;
  } catch {
    return undefined;
  }

  const relative =
    typeof manifest.bin === "string"
      ? manifest.bin
      : Object.values(manifest.bin ?? {})[0];

  if (!relative) return undefined;

  const resolved = path.join(packageDir, relative);

  return (await stat(resolved).catch(() => undefined)) ? resolved : undefined;
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
  const windowsHint =
    process.platform === "win32"
      ? [
          "",
          "On Windows, point it at the real executable rather than the npm shim:",
          "  %APPDATA%\\npm\\node_modules\\@github\\copilot-win32-x64\\copilot.exe",
          `Set ${COPILOT_CLI_BIN_ENV_KEY} to that path. A .cmd shim cannot be`,
          "started directly (Node reports EINVAL).",
        ].join("\n")
      : "";

  return [
    `GitHub Copilot CLI could not be started ("${binary}" did not answer --version).`,
    "Check the install and run `copilot login` if you have not signed in.",
    `Details: ${detail}`,
    windowsHint,
  ]
    .filter(Boolean)
    .join(" ");
}
