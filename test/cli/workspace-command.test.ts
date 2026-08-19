import { describe, expect, test } from "vitest";
import { parseCommand } from "../../src/cli/commands.ts";
import { parseWorkspaceCommand } from "../../src/cli/workspace-command.ts";

describe("parseWorkspaceCommand", () => {
  test("defaults to an init run over the given folder", () => {
    expect(parseWorkspaceCommand(["~/repos"])).toMatchObject({
      command: "init",
      kind: "workspace",
      modelId: null,
      only: [],
      outputDir: null,
      workspaceRoot: "~/repos",
    });
  });

  test("selects an update run", () => {
    expect(parseWorkspaceCommand(["~/repos", "--update"])).toMatchObject({
      command: "update",
    });
  });

  test("reads the output directory, model, and language", () => {
    expect(
      parseWorkspaceCommand([
        "~/repos",
        "--output",
        "~/wiki",
        "--model",
        "claude-sonnet-4.6",
        "--language",
        "tr",
      ]),
    ).toMatchObject({
      language: "tr",
      modelId: "claude-sonnet-4.6",
      outputDir: "~/wiki",
    });
  });

  test("accepts inline option values", () => {
    expect(
      parseWorkspaceCommand(["~/repos", "--output=~/wiki", "--model=gpt-5.1"]),
    ).toMatchObject({ modelId: "gpt-5.1", outputDir: "~/wiki" });
  });

  test("splits a comma-separated repository filter", () => {
    expect(
      parseWorkspaceCommand(["~/repos", "--only", "api, web ,"]),
    ).toMatchObject({ only: ["api", "web"] });
  });

  test("treats trailing words as guidance for the run", () => {
    expect(
      parseWorkspaceCommand(["~/repos", "focus", "on", "the", "API"]),
    ).toMatchObject({ userMessage: "focus on the API" });
  });

  test("requires a folder", () => {
    expect(parseWorkspaceCommand([])).toMatchObject({
      kind: "error",
      exitCode: 1,
    });
  });

  test("rejects an option with no value", () => {
    expect(parseWorkspaceCommand(["~/repos", "--output"])).toMatchObject({
      kind: "error",
      message: "--output requires a value.",
    });
  });

  test("rejects an unknown option", () => {
    expect(parseWorkspaceCommand(["~/repos", "--turbo"])).toMatchObject({
      kind: "error",
      message: "Unknown option for workspace: --turbo",
    });
  });
});

describe("parseCommand", () => {
  test("routes the workspace subcommand", () => {
    expect(parseCommand(["workspace", "~/repos"])).toMatchObject({
      kind: "workspace",
      workspaceRoot: "~/repos",
    });
  });

  test("leaves the default run command alone", () => {
    expect(parseCommand(["--init"]).kind).toBe("run");
  });
});
