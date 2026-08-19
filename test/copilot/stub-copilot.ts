import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** How the stub Copilot CLI should behave for one test. */
export interface StubCopilotOptions {
  /** Exit code the stub exits with. Defaults to 0. */
  exitCode?: number;

  /** Session events the stub prints, one JSON object per line. */
  events?: unknown[];

  /**
   * Fails the invocation when any argument contains this substring, so a test
   * can make one repository in a workspace fail while the others succeed.
   */
  failFor?: string;

  /**
   * Files the stub writes. A relative key lands in the working directory; an
   * absolute key is written as given, which lets a test simulate an agent that
   * ignores the read-only rule and writes into the source repository.
   */
  files?: Record<string, string>;

  /** Milliseconds to sleep before exiting, for timeout tests. */
  sleepMs?: number;

  /** Text the stub writes to stderr. */
  stderr?: string;
}

/** A stub Copilot CLI and the record of how it was invoked. */
export interface StubCopilot {
  /** Absolute path to the stub executable. */
  binary: string;

  /** The arguments of every invocation, in order. */
  invocations: () => Promise<{ args: string[]; cwd: string }[]>;
}

/**
 * Writes an executable stand-in for the Copilot CLI.
 *
 * The real binary needs a Copilot entitlement and a network round trip, so the
 * backend is exercised against a stub that speaks the same JSONL contract:
 * it records its arguments, writes whatever files the test expects the agent
 * to produce, prints the given events, and exits with the given code.
 */
export async function createStubCopilot(
  options: StubCopilotOptions = {},
): Promise<StubCopilot> {
  const dir = await mkdtemp(path.join(tmpdir(), "openwiki-stub-copilot-"));
  const binary = path.join(dir, "copilot");
  const log = path.join(dir, "invocations.jsonl");
  const config = {
    events: options.events ?? [],
    failFor: options.failFor ?? "",
    exitCode: options.exitCode ?? 0,
    files: options.files ?? {},
    log,
    sleepMs: options.sleepMs ?? 0,
    stderr: options.stderr ?? "",
  };

  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const config = ${JSON.stringify(config)};

// The backend probes the binary before it runs anything. Like the real CLI,
// the probe reports a version and does nothing else, so it is not recorded as
// an invocation and performs no writes.
if (process.argv.includes("--version")) {
  process.stdout.write("GitHub Copilot CLI 1.0.3 (stub)\\n");
  process.exit(0);
}

fs.appendFileSync(
  config.log,
  JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n",
);

const args = process.argv.slice(2);
const failing =
  config.failFor && args.some((arg) => arg.includes(config.failFor));

if (failing) {
  process.stdout.write(
    JSON.stringify({
      type: "session.error",
      data: { errorType: "tool", message: "stub failure for " + config.failFor },
    }) + "\\n",
  );
  process.exit(1);
}

for (const [name, content] of Object.entries(config.files)) {
  const target = path.isAbsolute(name) ? name : path.join(process.cwd(), name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

for (const event of config.events) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

if (config.stderr) process.stderr.write(config.stderr);

setTimeout(() => process.exit(config.exitCode), config.sleepMs);
`,
    "utf8",
  );
  await chmod(binary, 0o755);

  return {
    binary,
    invocations: async () => {
      const raw = await readFile(log, "utf8").catch(() => "");

      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
    },
  };
}

/** An assistant message event, as Copilot emits it. */
export function assistantMessage(content: string): unknown {
  return {
    type: "assistant.message",
    data: { content },
    timestamp: "2026-08-20T00:00:00Z",
  };
}

/** A fatal session error event, as Copilot emits it. */
export function sessionError(message: string, errorType = "auth"): unknown {
  return { type: "session.error", data: { errorType, message } };
}
