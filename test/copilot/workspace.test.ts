import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { discoverRepos, toSlug } from "../../src/copilot/workspace.ts";

/** Creates a workspace folder with the given directories. */
async function createWorkspace(
  entries: { git?: boolean; name: string }[],
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-workspace-"));

  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "README.md"), "# readme\n", "utf8");

    if (entry.git !== false) {
      await mkdir(path.join(dir, ".git"), { recursive: true });
    }
  }

  return root;
}

describe("toSlug", () => {
  test("lowercases and collapses separators", () => {
    expect(toSlug("My_Api Service")).toBe("my-api-service");
  });

  test("falls back to a usable slug when nothing survives", () => {
    expect(toSlug("!!!")).toBe("repo");
  });
});

describe("discoverRepos", () => {
  test("finds the git repositories in a folder, sorted by slug", async () => {
    const root = await createWorkspace([
      { name: "web-app" },
      { name: "api-service" },
    ]);

    const repos = await discoverRepos(root);

    expect(repos.map((repo) => repo.slug)).toEqual(["api-service", "web-app"]);
  });

  test("ignores non-git directories when git repositories exist", async () => {
    const root = await createWorkspace([
      { name: "api-service" },
      { git: false, name: "scratch-notes" },
    ]);

    expect((await discoverRepos(root)).map((repo) => repo.slug)).toEqual([
      "api-service",
    ]);
  });

  test("falls back to plain directories when no repository is a git repo", async () => {
    const root = await createWorkspace([
      { git: false, name: "alpha" },
      { git: false, name: "beta" },
    ]);

    expect((await discoverRepos(root)).map((repo) => repo.slug)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("treats a workspace that is itself a repository as one repo", async () => {
    const root = await createWorkspace([{ name: "inner" }]);
    await mkdir(path.join(root, ".git"), { recursive: true });

    const repos = await discoverRepos(root);

    expect(repos).toHaveLength(1);
    expect(repos[0]?.path).toBe(path.resolve(root));
  });

  test("skips hidden and vendored directories", async () => {
    const root = await createWorkspace([
      { name: "api-service" },
      { git: false, name: "node_modules" },
      { git: false, name: ".cache" },
    ]);

    expect((await discoverRepos(root)).map((repo) => repo.slug)).toEqual([
      "api-service",
    ]);
  });

  test("excludes the wiki output directory so a run never documents itself", async () => {
    const root = await createWorkspace([
      { git: false, name: "openwiki" },
      { git: false, name: "alpha" },
    ]);

    const repos = await discoverRepos(root, {
      excludeDir: path.join(root, "openwiki"),
    });

    expect(repos.map((repo) => repo.slug)).toEqual(["alpha"]);
  });

  test("limits discovery to the requested names", async () => {
    const root = await createWorkspace([
      { name: "api-service" },
      { name: "web-app" },
    ]);

    const repos = await discoverRepos(root, { only: ["web-app"] });

    expect(repos.map((repo) => repo.slug)).toEqual(["web-app"]);
  });

  test("matches a requested name that needs slugging", async () => {
    const root = await createWorkspace([{ name: "My_Api" }]);

    expect(
      (await discoverRepos(root, { only: ["My_Api"] })).map(
        (repo) => repo.slug,
      ),
    ).toEqual(["my-api"]);
  });

  test("fails loudly when a requested repository does not exist", async () => {
    const root = await createWorkspace([{ name: "api-service" }]);

    await expect(discoverRepos(root, { only: ["missing"] })).rejects.toThrow(
      /No repository matched: missing/u,
    );
  });

  test("rejects a workspace folder that does not exist", async () => {
    await expect(discoverRepos("/nonexistent/openwiki-test")).rejects.toThrow(
      /Workspace folder not found/u,
    );
  });

  test("gives colliding directory names distinct slugs", async () => {
    const root = await createWorkspace([
      { name: "my-api" },
      { name: "my_api" },
    ]);

    const slugs = (await discoverRepos(root)).map((repo) => repo.slug);

    expect(new Set(slugs).size).toBe(2);
    expect(slugs).toContain("my-api");
  });
});
