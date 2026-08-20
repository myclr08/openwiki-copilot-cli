/**
 * Parsing for `openwiki tdd`, the technical-design-document generator.
 *
 * Separate from the run/provider machinery for the same reason `workspace`
 * is: Copilot CLI owns its own auth and tool loop, so there is no provider
 * to configure — only a folder, an optional Jira key, and output knobs.
 */

/** A parsed `openwiki tdd` invocation. */
export interface TddCliCommand {
  exitCode: 0;
  kind: "tdd";

  /** Jira issue key to read as evidence, or null to run without Jira. */
  jiraKey: string | null;

  /** Copilot model id, or null for the backend default. */
  modelId: string | null;

  /** Where to copy the finished document, or null to leave it in the run dir. */
  outputFile: string | null;

  /** Custom template file, or null for the bundled company template. */
  templatePath: string | null;

  /** The folder holding the repositories and their `openwiki/` wiki. */
  workspaceRoot: string;
}

/** A parse failure, shaped like the CLI's other error results. */
interface TddCliError {
  exitCode: 1;
  kind: "error";
  message: string;
}

/** Options that take a value. */
const VALUE_OPTIONS = new Set([
  "--jira",
  "--model",
  "--modelId",
  "--output",
  "--template",
]);

/** Parses the arguments following `tdd`. */
export function parseTddCommand(args: string[]): TddCliCommand | TddCliError {
  let jiraKey: string | null = null;
  let modelId: string | null = null;
  let outputFile: string | null = null;
  let templatePath: string | null = null;
  let workspaceRoot: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const separator = arg.indexOf("=");
    const name =
      arg.startsWith("--") && separator > 0 ? arg.slice(0, separator) : arg;

    if (VALUE_OPTIONS.has(name)) {
      const inline =
        arg.startsWith("--") && separator > 0
          ? arg.slice(separator + 1)
          : undefined;
      const value = inline ?? args[index + 1];

      if (!value || (inline === undefined && value.startsWith("-"))) {
        return error(`${name} requires a value.`);
      }

      if (inline === undefined) index += 1;

      switch (name) {
        case "--jira":
          jiraKey = value;
          break;
        case "--model":
        case "--modelId":
          modelId = value;
          break;
        case "--output":
          outputFile = value;
          break;
        default:
          templatePath = value;
      }

      continue;
    }

    if (arg.startsWith("-")) {
      return error(`Unknown option for tdd: ${arg}`);
    }

    if (workspaceRoot === null) {
      workspaceRoot = arg;
      continue;
    }

    return error(`Unexpected argument: ${arg}`);
  }

  if (!workspaceRoot) {
    return error(
      "openwiki tdd requires a folder: openwiki tdd <folder> [--jira KEY]",
    );
  }

  return {
    exitCode: 0,
    jiraKey,
    kind: "tdd",
    modelId,
    outputFile,
    templatePath,
    workspaceRoot,
  };
}

/** Builds a parse error result. */
function error(message: string): TddCliError {
  return { exitCode: 1, kind: "error", message };
}
