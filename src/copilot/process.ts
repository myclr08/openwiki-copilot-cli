import { spawn } from "node:child_process";
import type { OpenWikiRunEvent } from "../agent/types.js";
import {
  githubMcpEnabled,
  resolveCopilotBinary,
  resolveCopilotTimeoutMs,
} from "./config.js";
import type { CopilotLauncher } from "./detect.js";
import { CopilotEventStream } from "./events.js";

/** How long a killed process is given to exit before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** Characters of stderr kept for the failure message. */
const MAX_STDERR = 4_000;

/** One Copilot CLI run. */
export interface CopilotInvocation {
  /** Extra directories Copilot may access, typically the source repository. */
  addDirs?: string[];

  /** Working directory; also the only place Copilot should write. */
  cwd: string;

  env?: NodeJS.ProcessEnv;

  /**
   * How to start Copilot, as resolved by the preflight. Defaults to spawning
   * the configured binary directly, which is what a POSIX install needs.
   */
  launcher?: CopilotLauncher;

  onEvent?: (event: OpenWikiRunEvent) => void;

  prompt: string;

  /** Copilot model id, or null to let Copilot choose. */
  model?: string | null;

  signal?: AbortSignal;

  timeoutMs?: number;
}

/** How one Copilot CLI run ended. */
export interface CopilotInvocationResult {
  exitCode: number | null;

  /** A fatal `session.error`, or a message derived from a non-zero exit. */
  fatalError?: string;

  /** Everything the assistant said, joined by blank lines. */
  text: string;

  timedOut: boolean;
}

/**
 * Builds the Copilot CLI argument list for one non-interactive run.
 *
 * The permission flags are deliberately narrow. `--allow-all-tools` lets the
 * agent work without prompting, but `--allow-all-paths` is never passed, so
 * file access stays limited to the working directory and whatever `--add-dir`
 * grants. `--no-ask-user` keeps a headless run from blocking on a question,
 * and `--stream off` suppresses token deltas the run log would double-print.
 */
export function buildCopilotArgs(
  invocation: Pick<CopilotInvocation, "addDirs" | "model" | "prompt">,
  env = process.env,
): string[] {
  const args = [
    "--prompt",
    invocation.prompt,
    "--allow-all-tools",
    "--no-ask-user",
    "--no-auto-update",
    "--no-color",
    "--log-level",
    "none",
    "--output-format",
    "json",
    "--stream",
    "off",
  ];

  if (!githubMcpEnabled(env)) {
    args.push("--disable-builtin-mcps");
  }

  if (invocation.model) {
    args.push("--model", invocation.model);
  }

  for (const dir of invocation.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  return args;
}

/**
 * Runs Copilot CLI once and streams its JSONL output as OpenWiki run events.
 *
 * Resolves for both success and failure: a non-zero exit or a fatal
 * `session.error` is reported through {@link CopilotInvocationResult.fatalError}
 * so the caller can record one failed repository and continue with the rest.
 * Only a process that cannot be spawned at all rejects.
 */
export async function runCopilot(
  invocation: CopilotInvocation,
): Promise<CopilotInvocationResult> {
  const env = invocation.env ?? process.env;
  const launcher = invocation.launcher ?? {
    command: resolveCopilotBinary(env),
    prefixArgs: [],
  };
  const timeoutMs = invocation.timeoutMs ?? resolveCopilotTimeoutMs(env);
  const stream = new CopilotEventStream();

  return await new Promise<CopilotInvocationResult>((resolve, reject) => {
    const child = spawn(
      launcher.command,
      [...launcher.prefixArgs, ...buildCopilotArgs(invocation, env)],
      {
        cwd: invocation.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdoutBuffer = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const stopTimers = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      invocation.signal?.removeEventListener("abort", onAbort);
    };

    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeoutTimer.unref?.();

    function onAbort() {
      terminate();
    }

    invocation.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;

      // Copilot writes one JSON object per line; hold the trailing partial
      // line until its newline arrives so a split chunk never parses as junk.
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        for (const event of stream.push(line)) {
          invocation.onEvent?.(event);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      stopTimers();
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      stopTimers();

      for (const event of stream.push(stdoutBuffer)) {
        invocation.onEvent?.(event);
      }

      resolve({
        exitCode: code,
        text: stream.text,
        timedOut,
        ...resolveFailure(stream.fatalError, code, timedOut, timeoutMs, stderr),
      });
    });
  });
}

/** Chooses the message that best explains a failed run, if it failed at all. */
function resolveFailure(
  fatalError: string | undefined,
  exitCode: number | null,
  timedOut: boolean,
  timeoutMs: number,
  stderr: string,
): { fatalError?: string } {
  if (timedOut) {
    return {
      fatalError: `Copilot CLI exceeded its ${Math.round(timeoutMs / 1000)}s budget and was stopped.`,
    };
  }

  // A reported session error explains the failure better than an exit code.
  if (fatalError) return { fatalError };

  if (exitCode === 0 || exitCode === null) return {};

  const detail = stderr.trim();

  return {
    fatalError: detail
      ? `Copilot CLI exited with code ${exitCode}: ${detail}`
      : `Copilot CLI exited with code ${exitCode}.`,
  };
}
