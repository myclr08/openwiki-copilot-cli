import { describe, expect, test } from "vitest";
import { parseCommand } from "../../src/cli/commands.ts";
import { parseTddCommand } from "../../src/cli/tdd-command.ts";

describe("parseTddCommand", () => {
  test("requires a workspace folder", () => {
    expect(parseTddCommand([])).toMatchObject({ kind: "error", exitCode: 1 });
  });

  test("parses the folder with defaults", () => {
    expect(parseTddCommand(["~/repos"])).toEqual({
      kind: "tdd",
      exitCode: 0,
      workspaceRoot: "~/repos",
      jiraKey: null,
      templatePath: null,
      modelId: null,
      outputFile: null,
    });
  });

  test("reads all options, space and inline forms", () => {
    expect(
      parseTddCommand([
        "~/repos",
        "--jira",
        "DNZ-1111",
        "--template=custom.md",
        "--model",
        "claude-sonnet-4.6",
        "--output=out.md",
      ]),
    ).toMatchObject({
      jiraKey: "DNZ-1111",
      templatePath: "custom.md",
      modelId: "claude-sonnet-4.6",
      outputFile: "out.md",
    });
  });

  test("rejects an option with no value and unknown options", () => {
    expect(parseTddCommand(["~/repos", "--jira"])).toMatchObject({
      kind: "error",
      message: "--jira requires a value.",
    });
    expect(parseTddCommand(["~/repos", "--turbo"])).toMatchObject({
      kind: "error",
      message: "Unknown option for tdd: --turbo",
    });
  });
});

describe("parseCommand", () => {
  test("routes the tdd subcommand", () => {
    expect(parseCommand(["tdd", "~/repos", "--jira", "DNZ-1"])).toMatchObject({
      kind: "tdd",
      workspaceRoot: "~/repos",
      jiraKey: "DNZ-1",
    });
  });
});
