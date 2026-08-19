/**
 * Parsing for `openwiki workspace`, the Copilot CLI backend's entry point.
 *
 * The command is separate from `openwiki --init` because it is a different
 * engine, not a different provider: Copilot CLI owns its own authentication
 * (`copilot login`) and its own tool loop, so it has no API key to configure
 * and no model to construct. Keeping it out of the provider registry keeps the
 * hosted-model paths untouched.
 */

/** A parsed `openwiki workspace` invocation. */
export interface WorkspaceCliCommand {
  /** `init` writes wikis from scratch; `update` refreshes them. */
  command: "init" | "update";

  exitCode: 0;

  kind: "workspace";

  language: string | null;

  /** Copilot model id, or null for the backend default. */
  modelId: string | null;

  /** Repository names or slugs to limit the run to. */
  only: string[];

  /** Wiki output root, or null for `openwiki/` inside the workspace. */
  outputDir: string | null;

  /** Extra guidance appended to every repository's prompt. */
  userMessage: string | null;

  /** The folder holding the repositories to document. */
  workspaceRoot: string;
}

/** A parse failure, shaped like the CLI's other error results. */
export interface WorkspaceCliError {
  exitCode: 1;
  kind: "error";
  message: string;
}

/** Options that take a value. */
const VALUE_OPTIONS = new Set([
  "--language",
  "--model",
  "--modelId",
  "--only",
  "--output",
]);

/**
 * Parses the arguments following `workspace`.
 *
 * Returns an error result rather than throwing so the CLI can print the
 * message and exit the same way it does for every other parse failure.
 */
export function parseWorkspaceCommand(
  args: string[],
): WorkspaceCliCommand | WorkspaceCliError {
  let command: "init" | "update" = "init";
  let language: string | null = null;
  let modelId: string | null = null;
  let outputDir: string | null = null;
  let userMessage: string | null = null;
  let workspaceRoot: string | null = null;
  const only: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--init" || arg === "--update") {
      command = arg === "--init" ? "init" : "update";
      continue;
    }

    const inlineSeparator = arg.indexOf("=");
    const name =
      arg.startsWith("--") && inlineSeparator > 0
        ? arg.slice(0, inlineSeparator)
        : arg;

    if (VALUE_OPTIONS.has(name)) {
      const inline =
        arg.startsWith("--") && inlineSeparator > 0
          ? arg.slice(inlineSeparator + 1)
          : undefined;
      const value = inline ?? args[index + 1];

      if (!value || (inline === undefined && value.startsWith("-"))) {
        return error(`${name} requires a value.`);
      }

      if (inline === undefined) index += 1;

      switch (name) {
        case "--language":
          language = value;
          break;
        case "--model":
        case "--modelId":
          modelId = value;
          break;
        case "--only":
          only.push(
            ...value
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean),
          );
          break;
        default:
          outputDir = value;
      }

      continue;
    }

    if (arg.startsWith("-")) {
      return error(`Unknown option for workspace: ${arg}`);
    }

    // The first bare argument is the folder; anything after it is guidance
    // for the run, matching how `openwiki --init "message"` reads.
    if (workspaceRoot === null) {
      workspaceRoot = arg;
      continue;
    }

    userMessage = userMessage ? `${userMessage} ${arg}` : arg;
  }

  if (!workspaceRoot) {
    return error(
      "openwiki workspace requires a folder: openwiki workspace <folder>",
    );
  }

  return {
    command,
    exitCode: 0,
    kind: "workspace",
    language,
    modelId,
    only,
    outputDir,
    userMessage,
    workspaceRoot,
  };
}

/** Builds a parse error result. */
function error(message: string): WorkspaceCliError {
  return { exitCode: 1, kind: "error", message };
}
