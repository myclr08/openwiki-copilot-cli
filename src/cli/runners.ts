import path from "node:path";
import {
  configureAuthProvider,
  listAuthProviderTools,
  shouldDiscoverToolsAfterAuth,
} from "../auth/configure.js";
import { startNgrokTunnel } from "../auth/ngrok.js";
import { formatAuthProviderList, runOAuthAuth } from "../auth/oauth.js";
import { createOpenWikiThreadId, runOpenWikiAgent } from "../agent/index.js";
import type { OpenWikiRunEvent, OpenWikiRunOptions } from "../agent/types.js";
import { resolveConfiguredProvider } from "../config/constants.js";
import {
  ensureCodeModeRepoSetup,
  runCodeModeConnectors,
} from "../ingestion/code-mode.js";
import { runOpenWikiIngestion } from "../ingestion/ingestion.js";
import { getErrorMessage } from "../platform/diagnostics.js";
import {
  deleteConnectorSchedules,
  getSavedPowerScheduleStatus,
  listConnectorSchedules,
  pauseConnectorSchedules,
  resumeConnectorSchedules,
} from "../scheduling/schedules.js";
import {
  readOpenWikiOnboardingConfig,
  saveOpenWikiOnboardingConfig,
} from "../setup/onboarding.js";
import type { RunTelemetryContext } from "../telemetry/index.js";
import { exportStaticVisualizer } from "../visualize/static-export.js";
import { runVisualizeServer } from "../visualize/server.js";
import { runCopilotWorkspace } from "../copilot/run.js";
import type { RepoRunResult } from "../copilot/types.js";
import type { WorkspaceCliCommand } from "./workspace-command.js";
import type { CliCommand } from "./commands.js";
import { isDebugMode } from "./debug.js";
import { getAuthFix, getAuthFixSteps } from "./diagnostics/auth-fix.js";
import { getErrorDiagnostics } from "./diagnostics/error-diagnostics.js";
import { getRunModeCwd, getRunModeOutputMode } from "./run-mode.js";
import {
  formatPowerScheduleStatus,
  formatScheduleHeader,
  formatScheduleMutationResult,
  formatScheduleStatus,
} from "./schedule-format.js";

export async function runNgrokCommand(
  command: Extract<CliCommand, { kind: "ngrok" }>,
): Promise<void> {
  try {
    await startNgrokTunnel({
      port: command.port,
      url: command.url,
    });
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Start the wiki visualizer server or export its static files for web hosting.
 */
export async function runVisualizeCommand(
  command: Extract<CliCommand, { kind: "visualize" }>,
): Promise<void> {
  const wikiRoot = path.resolve(process.cwd(), command.wikiDir);
  try {
    if (command.exportDir) {
      const result = await exportStaticVisualizer({
        wikiRoot,
        outputDir: path.resolve(process.cwd(), command.exportDir),
      });
      process.stdout.write(
        `Exported static visualizer to ${result.outputDir} (${result.graph.nodes.length} pages, ${result.graph.edges.length} links).\n`,
      );
      return;
    }

    await runVisualizeServer({
      wikiRoot,
      port: command.port,
      open: command.open,
    });
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

export async function runCronCommand(
  command: Extract<CliCommand, { kind: "cron" }>,
): Promise<void> {
  try {
    const config = await readOpenWikiOnboardingConfig();

    if (command.action !== "list") {
      if (!command.target) {
        throw new Error(`Target is required for cron ${command.action}.`);
      }

      const result =
        command.action === "pause"
          ? await pauseConnectorSchedules(config, command.target)
          : command.action === "resume"
            ? await resumeConnectorSchedules({
                config,
                cwd: process.cwd(),
                target: command.target,
              })
            : await deleteConnectorSchedules(config, command.target);

      await saveOpenWikiOnboardingConfig(result.config);
      process.stdout.write(
        formatScheduleMutationResult(command.action, result),
      );
      await printCronSchedules(result.config);
      process.exitCode = 0;
      return;
    }

    await printCronSchedules(config);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function printCronSchedules(
  config: Awaited<ReturnType<typeof readOpenWikiOnboardingConfig>>,
): Promise<void> {
  const schedules = await listConnectorSchedules(config);
  const powerSchedule = getSavedPowerScheduleStatus(config);

  process.stdout.write(formatScheduleHeader(schedules.length));
  process.stdout.write(formatPowerScheduleStatus(powerSchedule));

  if (schedules.length === 0) {
    process.stdout.write("No connector schedules are configured.\n");
    return;
  }

  for (const schedule of schedules) {
    process.stdout.write(formatScheduleStatus(schedule));
  }
}

export async function runIngestCommand(
  command: Extract<CliCommand, { kind: "ingest" }>,
): Promise<void> {
  try {
    const result = await runOpenWikiIngestion(process.cwd(), {
      debug: isDebugMode(),
      modelId: command.modelId,
      scheduledOnly: command.scheduledOnly,
      target: command.target,
      onEvent: (event) => {
        if (event.type === "text" && event.source !== "subgraph") {
          process.stdout.write(event.text);
        }
      },
    });

    process.stdout.write("\nIngestion summary\n");
    for (const sourceResult of result.results) {
      process.stdout.write(
        `- ${sourceResult.displayName}: ${sourceResult.status}; ${sourceResult.rawFiles.length} raw file(s)\n`,
      );
    }

    const hadError = result.results.some(
      (sourceResult) => sourceResult.status === "error",
    );

    process.exitCode = hadError ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    writePrintErrorDiagnostics(error);
    process.exitCode = 1;
  }
}

export async function runAuthCommand(
  command: Extract<CliCommand, { kind: "auth" }>,
): Promise<void> {
  try {
    if (command.action === "list") {
      process.stdout.write(`${formatAuthProviderList()}\n`);
    } else {
      if (command.provider === null) {
        throw new Error("Auth provider is required.");
      }

      if (command.action === "configure") {
        const result = await configureAuthProvider(command.provider, {
          force: command.force,
        });
        process.stdout.write(
          `${result.status === "exists" ? "Config already exists" : `Config ${result.status}`}: ${result.configPath}\n`,
        );
        for (const nextStep of result.nextSteps) {
          process.stdout.write(`- ${nextStep}\n`);
        }
      } else if (command.action === "tools") {
        const result = await listAuthProviderTools(command.provider);
        process.stdout.write(
          `Tools for ${result.provider} (${result.configPath})\n`,
        );
        process.stdout.write(`Wrote discovery: ${result.rawFile}\n`);
        process.stdout.write(`${JSON.stringify(result.tools, null, 2)}\n`);
      } else {
        const result = await runOAuthAuth(command.provider);
        process.stdout.write(
          `Saved ${result.provider} auth values: ${result.savedEnvKeys.join(", ")}\n`,
        );
        const configureResult = await configureAuthProvider(command.provider, {
          force: command.force,
        });
        process.stdout.write(
          `${configureResult.status === "exists" ? "Config already exists" : `Config ${configureResult.status}`}: ${configureResult.configPath}\n`,
        );
        for (const nextStep of configureResult.nextSteps) {
          process.stdout.write(`- ${nextStep}\n`);
        }

        if (shouldDiscoverToolsAfterAuth(command.provider)) {
          try {
            const toolsResult = await listAuthProviderTools(command.provider);
            process.stdout.write(
              `Discovered ${toolsResult.tools.length} MCP tool(s); wrote ${toolsResult.rawFile}\n`,
            );
            const toolNames = toolsResult.tools
              .map((tool) => tool.name)
              .slice(0, 20);
            if (toolNames.length > 0) {
              process.stdout.write(`Tools: ${toolNames.join(", ")}\n`);
            }
          } catch (error) {
            process.stdout.write(
              `MCP tool discovery skipped: ${getErrorMessage(error)}\n`,
            );
          }
        }
      }
    }

    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Builds the telemetry context for a run from the parsed command. Flag names
 * only, never argument values.
 */
export async function runPrintCommand(
  command: Extract<CliCommand, { kind: "run" }>,
): Promise<void> {
  try {
    const output: string[] = [];

    const runtimeCwd = getRunModeCwd(command.mode);
    const runtimeOutputMode = getRunModeOutputMode(command.mode);

    const handlePrintEvent = (event: OpenWikiRunEvent): void => {
      if (event.type === "text" && event.source !== "subgraph") {
        output.push(event.text);
      }
    };

    const runOptions: OpenWikiRunOptions = {
      debug: isDebugMode(),
      isFollowup: command.command === "chat",
      language: command.language,
      modelId: command.modelId,
      outputMode: runtimeOutputMode,
      threadId: createOpenWikiThreadId(runtimeCwd),
      onEvent: handlePrintEvent,
    };

    const telemetryContext: RunTelemetryContext = {};

    if (command.mode === "code") {
      await ensureCodeModeRepoSetup(runtimeCwd, {
        createWorkflow: command.command === "init",
      });
    }

    // Code-mode connectors (e.g. langsmith) pull their evidence and augment
    // the agent message before the run, so --print behaves exactly like
    // interactive.
    const userMessage =
      command.mode === "code" && command.command !== "chat"
        ? await runCodeModeConnectors(
            runtimeCwd,
            command.userMessage ?? undefined,
            handlePrintEvent,
          )
        : command.userMessage;

    await runOpenWikiAgent(
      command.command,
      runtimeCwd,
      { ...runOptions, userMessage },
      telemetryContext,
    );

    const text = output.join("").trim();

    if (text.length > 0) {
      process.stdout.write(`${text}\n`);
    }

    process.exitCode = 0;
  } catch (error) {
    const message = getErrorMessage(error);
    process.stderr.write(`${message}\n`);
    writePrintAuthFix(error, message);
    writePrintErrorDiagnostics(error);
    process.exitCode = 1;
  }
}

/**
 * Write the concise auth "how to fix" guidance to stderr on a non-interactive
 * failure, mirroring the interactive panel so CI/print runs get the same help.
 * No-op unless the failure looks like an auth error. Key names only.
 */
export function writePrintAuthFix(error: unknown, message: string): void {
  const authFix = getAuthFix(error, message, resolveConfiguredProvider());

  if (!authFix) {
    return;
  }

  process.stderr.write("\nHow to fix\n");
  process.stderr.write(
    "Your provider rejected the credentials for this run.\n",
  );

  getAuthFixSteps(authFix).forEach((step, index) => {
    process.stderr.write(`${index + 1}. ${step}\n`);
  });

  process.stderr.write("For full detail, re-run with --debug.\n");
}

export function writePrintErrorDiagnostics(error: unknown): void {
  const diagnostics = getErrorDiagnostics(error);

  if (diagnostics.length === 0) {
    return;
  }

  process.stderr.write("\nError Diagnostics\n");

  for (const diagnostic of diagnostics) {
    process.stderr.write(`${diagnostic.label}: ${diagnostic.value}\n`);
  }
}

/**
 * Runs `openwiki workspace`: document every repository in a folder with
 * Copilot CLI.
 *
 * Output is line-oriented rather than a TUI because a workspace run is long
 * and usually watched in a scrollback or a CI log. Tool activity is shown only
 * under OPENWIKI_DEBUG; the default stream is the run's narration plus a final
 * per-repository summary.
 *
 * The exit code is 1 when any repository failed, so a scheduled run fails
 * loudly instead of reporting success over a half-written wiki.
 */
export async function runWorkspaceCommand(
  command: WorkspaceCliCommand,
): Promise<void> {
  const debug = isDebugMode();

  try {
    const result = await runCopilotWorkspace({
      command: command.command,
      language: command.language,
      modelId: command.modelId,
      only: command.only,
      outputDir: command.outputDir,
      userMessage: command.userMessage,
      workspaceRoot: command.workspaceRoot,
      onEvent: (event) => {
        if (event.type === "text") {
          process.stdout.write(`${event.text.trim()}\n`);
          return;
        }

        if (!debug) return;

        if (event.type === "debug") {
          process.stderr.write(`${event.message}\n`);
        } else if (event.type === "tool_start") {
          process.stderr.write(`  → ${event.call}\n`);
        }
      },
    });

    process.stdout.write(
      formatWorkspaceSummary(result.results, result.wikiRoot),
    );
    process.exitCode = result.results.some(
      (entry) => entry.outcome === "failed",
    )
      ? 1
      : 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/** Renders the end-of-run report for a workspace run. */
export function formatWorkspaceSummary(
  results: RepoRunResult[],
  wikiRoot: string,
): string {
  const counts = {
    failed: results.filter((entry) => entry.outcome === "failed").length,
    skipped: results.filter((entry) => entry.outcome === "skipped").length,
    succeeded: results.filter((entry) => entry.outcome === "succeeded").length,
  };

  const lines = ["", `Wiki: ${wikiRoot}`];

  for (const entry of results) {
    const detail =
      entry.outcome === "failed"
        ? ` — ${entry.error ?? "failed"}`
        : entry.outcome === "skipped"
          ? ` — ${entry.reason ?? "skipped"}`
          : "";
    lines.push(`  ${symbolFor(entry.outcome)} ${entry.repo.slug}${detail}`);

    if (entry.dirtyPaths.length > 0) {
      lines.push(
        `      warning: modified ${entry.dirtyPaths.length} path(s) in the source repository`,
      );
    }
  }

  lines.push(
    "",
    `${counts.succeeded} documented, ${counts.skipped} skipped, ${counts.failed} failed.`,
    "",
  );

  return lines.join("\n");
}

/** The status glyph shown beside a repository in the summary. */
function symbolFor(outcome: RepoRunResult["outcome"]): string {
  if (outcome === "succeeded") return "✓";

  return outcome === "skipped" ? "–" : "✗";
}
