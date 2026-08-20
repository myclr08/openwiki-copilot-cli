import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { COPILOT_CLI_BIN_ENV_KEY } from "../../src/copilot/config.ts";
import { runCopilotWorkspace } from "../../src/copilot/run.ts";
import { assistantMessage, createStubCopilot } from "./stub-copilot.ts";

const execFileAsync = promisify(execFile);

const PAGE = `---
type: Reference
title: Overview
description: What this service does.
---

# Overview

The service does a thing.
`;

const ROOT_INDEX = `---
okf_version: "0.2"
title: Workspace
description: Every repository in the folder.
---

# Workspace

- [api-service](repos/api-service/index.md)
`;

/** Creates a workspace of initialized git repositories. */
async function createWorkspace(names: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-run-"));

  for (const name of names) {
    const repo = path.join(root, name);
    await mkdir(repo, { recursive: true });
    await writeFile(
      path.join(repo, "index.js"),
      "export const x = 1;\n",
      "utf8",
    );
    await execFileAsync("git", ["init", "--quiet"], { cwd: repo });
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test",
        "commit",
        "--quiet",
        "-m",
        "init",
      ],
      { cwd: repo },
    );
  }

  return root;
}

let previousBinary: string | undefined;

beforeEach(() => {
  previousBinary = process.env[COPILOT_CLI_BIN_ENV_KEY];
});

afterEach(() => {
  if (previousBinary === undefined) {
    delete process.env[COPILOT_CLI_BIN_ENV_KEY];
  } else {
    process.env[COPILOT_CLI_BIN_ENV_KEY] = previousBinary;
  }
});

/** Points the backend at a stub binary for the duration of one test. */
function useStub(binary: string): void {
  process.env[COPILOT_CLI_BIN_ENV_KEY] = binary;
}

describe("runCopilotWorkspace", () => {
  test("documents every repository into one central wiki", async () => {
    const root = await createWorkspace(["api-service", "web-app"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    const result = await runCopilotWorkspace({
      command: "init",
      workspaceRoot: root,
    });

    expect(result.results.map((entry) => entry.outcome)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(result.wikiRoot).toBe(path.join(root, "openwiki"));
    expect(
      await readFile(
        path.join(result.wikiRoot, "repos", "api-service", "overview.md"),
        "utf8",
      ),
    ).toContain("# Overview");
  });

  test("leaves the source repositories untouched", async () => {
    const root = await createWorkspace(["api-service"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    await runCopilotWorkspace({ command: "init", workspaceRoot: root });

    const entries = await readdir(path.join(root, "api-service"));

    expect(entries.sort()).toEqual([".git", "index.js"]);
  });

  test("grants the source repository as a read directory, not the write root", async () => {
    const root = await createWorkspace(["api-service"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    await runCopilotWorkspace({ command: "init", workspaceRoot: root });

    const [first] = await stub.invocations();

    expect(first?.cwd).toBe(
      path.join(root, "openwiki", "repos", "api-service"),
    );
    expect(first?.args).toContain(path.join(root, "api-service"));
  });

  test("generates directory indexes for each repository wiki", async () => {
    const root = await createWorkspace(["api-service"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    const result = await runCopilotWorkspace({
      command: "init",
      workspaceRoot: root,
    });

    const index = await readFile(
      path.join(result.wikiRoot, "repos", "api-service", "index.md"),
      "utf8",
    );

    expect(index).toContain("overview.md");
  });

  test("runs a final pass at the wiki root to write the cross-repo index", async () => {
    const root = await createWorkspace(["api-service", "web-app"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    const result = await runCopilotWorkspace({
      command: "init",
      workspaceRoot: root,
    });
    const invocations = await stub.invocations();

    expect(result.indexWritten).toBe(true);
    expect(invocations).toHaveLength(3);
    expect(invocations[2]?.cwd).toBe(result.wikiRoot);
  });

  test("records the commit each wiki was generated from", async () => {
    const root = await createWorkspace(["api-service"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    const result = await runCopilotWorkspace({
      command: "init",
      workspaceRoot: root,
    });
    const marker = JSON.parse(
      await readFile(
        path.join(result.wikiRoot, "repos", "api-service", ".last-update.json"),
        "utf8",
      ),
    ) as { gitHead?: string; status?: string };

    expect(marker.status).toBe("complete");
    expect(marker.gitHead).toMatch(/^[0-9a-f]{40}$/u);
  });

  test("skips an unchanged repository on update", async () => {
    const root = await createWorkspace(["api-service"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    await runCopilotWorkspace({ command: "init", workspaceRoot: root });
    const result = await runCopilotWorkspace({
      command: "update",
      workspaceRoot: root,
    });

    expect(result.results[0]?.outcome).toBe("skipped");
    expect(result.results[0]?.reason).toBe("unchanged");
  });

  test("does not rebuild the index when every repository was skipped", async () => {
    const root = await createWorkspace(["api-service"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      // The root pass writes index.md, so the second run has one to keep.
      files: { "index.md": ROOT_INDEX, "overview.md": PAGE },
    });
    useStub(stub.binary);

    await runCopilotWorkspace({ command: "init", workspaceRoot: root });
    const afterInit = (await stub.invocations()).length;
    const result = await runCopilotWorkspace({
      command: "update",
      workspaceRoot: root,
    });

    expect(result.indexWritten).toBe(false);
    expect(await stub.invocations()).toHaveLength(afterInit);
  });

  test("rebuilds a missing index even when every repository was skipped", async () => {
    const root = await createWorkspace(["api-service"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "index.md": ROOT_INDEX, "overview.md": PAGE },
    });
    useStub(stub.binary);

    const first = await runCopilotWorkspace({
      command: "init",
      workspaceRoot: root,
    });
    await rm(path.join(first.wikiRoot, "index.md"), { force: true });

    const result = await runCopilotWorkspace({
      command: "update",
      workspaceRoot: root,
    });

    expect(result.indexWritten).toBe(true);
  });

  test("keeps documenting after one repository fails", async () => {
    const root = await createWorkspace(["api-service", "web-app"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      failFor: `${path.sep}web-app`,
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    const result = await runCopilotWorkspace({
      command: "init",
      workspaceRoot: root,
    });

    expect(
      result.results.map((entry) => [entry.repo.slug, entry.outcome]),
    ).toEqual([
      ["api-service", "succeeded"],
      ["web-app", "failed"],
    ]);
    expect(result.results[1]?.error).toContain("stub failure");
  });

  test("warns when a run modifies the source repository", async () => {
    const root = await createWorkspace(["api-service"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: {
        "overview.md": PAGE,
        [path.join(root, "api-service", "stray.md")]: "oops\n",
      },
    });
    useStub(stub.binary);

    const result = await runCopilotWorkspace({
      command: "init",
      workspaceRoot: root,
    });

    expect(result.results[0]?.dirtyPaths).toContain("stray.md");
  });

  test("keeps every documented repository in the index when the run is narrowed", async () => {
    const root = await createWorkspace(["api-service", "web-app"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "index.md": ROOT_INDEX, "overview.md": PAGE },
    });
    useStub(stub.binary);

    await runCopilotWorkspace({ command: "init", workspaceRoot: root });
    await runCopilotWorkspace({
      command: "init",
      only: ["web-app"],
      workspaceRoot: root,
    });

    // The index page is rewritten whole. Prompting it with only the repository
    // this run touched is what erased the others from the index.
    const indexPrompt = (await stub.invocations()).at(-1)?.args.join(" ") ?? "";

    expect(indexPrompt).toContain("api-service");
    expect(indexPrompt).toContain("web-app");
  });

  test("keeps a repository in the index after its own run fails", async () => {
    const root = await createWorkspace(["api-service", "web-app"]);
    const ok = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "index.md": ROOT_INDEX, "overview.md": PAGE },
    });
    useStub(ok.binary);
    await runCopilotWorkspace({ command: "init", workspaceRoot: root });

    const failing = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      failFor: `${path.sep}web-app`,
      files: { "index.md": ROOT_INDEX, "overview.md": PAGE },
    });
    useStub(failing.binary);
    await runCopilotWorkspace({ command: "init", workspaceRoot: root });

    const indexPrompt =
      (await failing.invocations()).at(-1)?.args.join(" ") ?? "";

    expect(indexPrompt).toContain("api-service");
    expect(indexPrompt).toContain("web-app");
  });

  test("keeps a wiki section whose source repository is gone", async () => {
    const root = await createWorkspace(["api-service", "web-app"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "index.md": ROOT_INDEX, "overview.md": PAGE },
    });
    useStub(stub.binary);

    await runCopilotWorkspace({ command: "init", workspaceRoot: root });
    await rm(path.join(root, "web-app"), { force: true, recursive: true });
    await runCopilotWorkspace({ command: "init", workspaceRoot: root });

    const indexPrompt = (await stub.invocations()).at(-1)?.args.join(" ") ?? "";

    expect(indexPrompt).toContain("web-app");
  });

  test("limits the run to the requested repositories", async () => {
    const root = await createWorkspace(["api-service", "web-app"]);
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    const result = await runCopilotWorkspace({
      command: "init",
      only: ["web-app"],
      workspaceRoot: root,
    });

    expect(result.results.map((entry) => entry.repo.slug)).toEqual(["web-app"]);
  });

  test("writes to the requested output directory", async () => {
    const root = await createWorkspace(["api-service"]);
    const output = await mkdtemp(path.join(tmpdir(), "openwiki-out-"));
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    const result = await runCopilotWorkspace({
      command: "init",
      outputDir: output,
      workspaceRoot: root,
    });

    expect(result.wikiRoot).toBe(path.resolve(output));
  });

  test("passes the workspace brief into the prompt", async () => {
    const root = await createWorkspace(["api-service"]);
    const wikiRoot = path.join(root, "openwiki");
    await mkdir(wikiRoot, { recursive: true });
    await writeFile(
      path.join(wikiRoot, "INSTRUCTIONS.md"),
      "Focus on the public HTTP surface.\n",
      "utf8",
    );
    const stub = await createStubCopilot({
      events: [assistantMessage("Documented.")],
      files: { "overview.md": PAGE },
    });
    useStub(stub.binary);

    await runCopilotWorkspace({ command: "init", workspaceRoot: root });
    const [first] = await stub.invocations();

    expect(first?.args.join(" ")).toContain(
      "Focus on the public HTTP surface.",
    );
  });

  test("fails before touching any repository when Copilot is unavailable", async () => {
    const root = await createWorkspace(["api-service"]);
    useStub("/nonexistent/copilot");

    await expect(
      runCopilotWorkspace({ command: "init", workspaceRoot: root }),
    ).rejects.toThrow(/Copilot CLI was not found/u);
  });

  test("reports an empty workspace instead of writing an empty wiki", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-empty-"));
    const stub = await createStubCopilot({});
    useStub(stub.binary);

    await expect(
      runCopilotWorkspace({ command: "init", workspaceRoot: root }),
    ).rejects.toThrow(/No repositories found/u);
  });
});
