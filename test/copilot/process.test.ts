import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { COPILOT_CLI_BIN_ENV_KEY } from "../../src/copilot/config.ts";
import { buildCopilotArgs, runCopilot } from "../../src/copilot/process.ts";
import type { OpenWikiRunEvent } from "../../src/agent/types.ts";
import {
  assistantMessage,
  createStubCopilot,
  sessionError,
} from "./stub-copilot.ts";

/** An environment pointing the backend at a stub binary. */
function stubEnv(binary: string): NodeJS.ProcessEnv {
  return { ...process.env, [COPILOT_CLI_BIN_ENV_KEY]: binary };
}

describe("buildCopilotArgs", () => {
  test("runs non-interactively with tool permission but not path permission", () => {
    const args = buildCopilotArgs({ prompt: "document this" }, {});

    expect(args).toContain("--allow-all-tools");
    expect(args).toContain("--no-ask-user");
    expect(args).toEqual(expect.arrayContaining(["--output-format", "json"]));
    // Granting every path would let the agent write outside its wiki directory.
    expect(args).not.toContain("--allow-all-paths");
    expect(args).not.toContain("--allow-all");
    expect(args).not.toContain("--yolo");
  });

  test("passes the prompt and the model", () => {
    const args = buildCopilotArgs(
      { model: "claude-sonnet-4.6", prompt: "hello" },
      {},
    );

    expect(args[args.indexOf("--prompt") + 1]).toBe("hello");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4.6");
  });

  test("grants read access to each source repository", () => {
    const args = buildCopilotArgs(
      { addDirs: ["/repos/api", "/repos/web"], prompt: "x" },
      {},
    );

    expect(args.filter((arg) => arg === "--add-dir")).toHaveLength(2);
    expect(args).toContain("/repos/api");
  });

  test("disables built-in MCP servers unless opted in", () => {
    expect(buildCopilotArgs({ prompt: "x" }, {})).toContain(
      "--disable-builtin-mcps",
    );
    expect(
      buildCopilotArgs({ prompt: "x" }, { OPENWIKI_COPILOT_GITHUB_MCP: "1" }),
    ).not.toContain("--disable-builtin-mcps");
  });
});

describe("runCopilot", () => {
  test("streams events and collects the assistant's text", async () => {
    const stub = await createStubCopilot({
      events: [
        {
          type: "tool.execution_start",
          data: { toolCallId: "c1", toolName: "view", arguments: {} },
        },
        {
          type: "tool.execution_complete",
          data: { toolCallId: "c1", success: true },
        },
        assistantMessage("Documented the service."),
      ],
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-"));
    const events: OpenWikiRunEvent[] = [];

    const result = await runCopilot({
      cwd,
      env: stubEnv(stub.binary),
      onEvent: (event) => events.push(event),
      prompt: "document",
    });

    expect(result.exitCode).toBe(0);
    expect(result.fatalError).toBeUndefined();
    expect(result.text).toBe("Documented the service.");
    expect(events.map((event) => event.type)).toEqual([
      "tool_start",
      "tool_end",
      "text",
    ]);
  });

  test("runs in the given directory and lets the agent write there", async () => {
    const stub = await createStubCopilot({
      events: [assistantMessage("done")],
      files: { "overview.md": "# Overview\n" },
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-"));

    await runCopilot({ cwd, env: stubEnv(stub.binary), prompt: "document" });

    expect(await readFile(path.join(cwd, "overview.md"), "utf8")).toBe(
      "# Overview\n",
    );
    expect((await stub.invocations())[0]?.cwd).toBe(cwd);
  });

  test("reports a fatal session error instead of throwing", async () => {
    const stub = await createStubCopilot({
      events: [sessionError("Access denied by policy settings")],
      exitCode: 1,
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-"));

    const result = await runCopilot({
      cwd,
      env: stubEnv(stub.binary),
      prompt: "document",
    });

    expect(result.fatalError).toBe("Access denied by policy settings");
  });

  test("explains a bare non-zero exit with the stderr tail", async () => {
    const stub = await createStubCopilot({ exitCode: 3, stderr: "kaboom" });
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-"));

    const result = await runCopilot({
      cwd,
      env: stubEnv(stub.binary),
      prompt: "document",
    });

    expect(result.fatalError).toBe("Copilot CLI exited with code 3: kaboom");
  });

  test("stops a run that exceeds its budget", async () => {
    const stub = await createStubCopilot({ sleepMs: 10_000 });
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-"));

    const result = await runCopilot({
      cwd,
      env: stubEnv(stub.binary),
      prompt: "document",
      timeoutMs: 150,
    });

    expect(result.timedOut).toBe(true);
    expect(result.fatalError).toMatch(/budget/u);
  });

  test("rejects when the binary cannot be spawned", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-run-"));

    await expect(
      runCopilot({
        cwd,
        env: {
          ...process.env,
          [COPILOT_CLI_BIN_ENV_KEY]: "/nonexistent/copilot",
        },
        prompt: "document",
      }),
    ).rejects.toThrow();
  });
});
