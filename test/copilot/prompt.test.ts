import { describe, expect, test } from "vitest";
import { buildIndexPrompt, buildRepoPrompt } from "../../src/copilot/prompt.ts";

const repo = { path: "/repos/api-service", slug: "api-service" };

describe("buildRepoPrompt", () => {
  test("names the source repository and forbids writing to it", () => {
    const prompt = buildRepoPrompt({ command: "init", repo });

    expect(prompt).toContain("/repos/api-service");
    expect(prompt).toMatch(/Never create, edit, or delete anything inside it/u);
  });

  test("asks an init run to plan before writing", () => {
    expect(buildRepoPrompt({ command: "init", repo })).toContain(
      "_skeleton.md",
    );
  });

  test("gives an update run the previous commit to diff against", () => {
    const prompt = buildRepoPrompt({
      command: "update",
      previousGitHead: "abc123",
      repo,
    });

    expect(prompt).toContain("abc123..HEAD");
  });

  test("falls back to recent history when no previous run is recorded", () => {
    const prompt = buildRepoPrompt({ command: "update", repo });

    expect(prompt).toContain("log --oneline -50");
    expect(prompt).not.toContain("..HEAD");
  });

  test("states the output language only when one is requested", () => {
    expect(
      buildRepoPrompt({ command: "init", language: "tr", repo }),
    ).toContain("write all prose in tr");
    expect(buildRepoPrompt({ command: "init", repo })).not.toContain(
      "write all prose in",
    );
  });

  test("carries the workspace brief and the run's request", () => {
    const prompt = buildRepoPrompt({
      command: "init",
      instructions: "Prioritize the HTTP surface.",
      repo,
      userMessage: "Skip the vendored code.",
    });

    expect(prompt).toContain("Prioritize the HTTP surface.");
    expect(prompt).toContain("Skip the vendored code.");
  });

  test("reserves index.md for the deterministic pass", () => {
    expect(buildRepoPrompt({ command: "init", repo })).toMatch(
      /Do not create or edit any index\.md/u,
    );
  });
});

describe("buildIndexPrompt", () => {
  test("lists every repository it must link", () => {
    const prompt = buildIndexPrompt({
      repos: [repo, { path: "/repos/web-app", slug: "web-app" }],
      workspaceRoot: "/repos",
    });

    expect(prompt).toContain("api-service");
    expect(prompt).toContain("web-app");
    expect(prompt).toContain("repos/<slug>/index.md");
  });

  test("forbids editing the per-repository wikis", () => {
    expect(
      buildIndexPrompt({ repos: [repo], workspaceRoot: "/repos" }),
    ).toContain("Do not modify any page under repos/");
  });
});
