import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  METADATA_FILE,
  canSkipUpdate,
  readRepoMetadata,
  writeRepoMetadata,
} from "../../src/copilot/metadata.ts";

const base = {
  command: "init" as const,
  gitHead: "abc123",
  model: "claude-sonnet-4.6",
  status: "complete" as const,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

describe("canSkipUpdate", () => {
  test("skips when the recorded commit matches the current one", () => {
    expect(canSkipUpdate(base, "abc123", null)).toBe(true);
  });

  test("does not skip when the repository moved on", () => {
    expect(canSkipUpdate(base, "def456", null)).toBe(false);
  });

  test("does not skip without a previous run", () => {
    expect(canSkipUpdate(null, "abc123", null)).toBe(false);
  });

  test("does not skip after an interrupted run", () => {
    expect(
      canSkipUpdate({ ...base, status: "interrupted" }, "abc123", null),
    ).toBe(false);
  });

  test("does not skip when the requested language differs", () => {
    expect(canSkipUpdate({ ...base, language: "en" }, "abc123", "tr")).toBe(
      false,
    );
  });

  test("skips when the requested language matches the recorded one", () => {
    expect(canSkipUpdate({ ...base, language: "tr" }, "abc123", "tr")).toBe(
      true,
    );
  });

  test("does not skip a repository with no commit", () => {
    expect(canSkipUpdate(base, undefined, null)).toBe(false);
  });
});

describe("repository metadata", () => {
  test("round-trips through the wiki directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-metadata-"));

    await writeRepoMetadata(dir, base);

    expect(await readRepoMetadata(dir)).toEqual(base);
  });

  test("reads a missing marker as no previous run", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-metadata-"));

    expect(await readRepoMetadata(dir)).toBeNull();
  });

  test("reads a corrupt marker as no previous run", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-metadata-"));
    await writeFile(path.join(dir, METADATA_FILE), "{ broken", "utf8");

    expect(await readRepoMetadata(dir)).toBeNull();
  });
});
