import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { COPILOT_CLI_BIN_ENV_KEY } from "../../src/copilot/config.ts";
import {
  ensureCopilotAvailable,
  resolveCopilotLaunchers,
} from "../../src/copilot/detect.ts";

const PLATFORM_PACKAGE = `copilot-${process.platform}-${process.arch}`;

/**
 * Builds the directory layout a global npm install produces: an unspawnable
 * shim beside a node_modules tree holding the Node loader and the platform
 * executable.
 */
async function createNpmInstall(options: {
  loader?: boolean;
  platformBinary?: boolean;
}): Promise<{ shim: string }> {
  const prefix = await mkdtemp(path.join(tmpdir(), "openwiki-npm-"));
  const modules = path.join(prefix, "node_modules", "@github");
  const shim = path.join(prefix, "copilot.cmd");

  await mkdir(modules, { recursive: true });
  await writeFile(shim, "@ECHO off\n", "utf8");

  if (options.loader) {
    const dir = path.join(modules, "copilot");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ bin: { copilot: "npm-loader.js" } }),
      "utf8",
    );
    await writeFile(
      path.join(dir, "npm-loader.js"),
      'process.stdout.write("GitHub Copilot CLI 1.0.80 (loader)\\n");\n',
      "utf8",
    );
  }

  if (options.platformBinary) {
    const dir = path.join(modules, PLATFORM_PACKAGE);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ bin: { [PLATFORM_PACKAGE]: "copilot.bin" } }),
      "utf8",
    );
    const executable = path.join(dir, "copilot.bin");
    await writeFile(
      executable,
      '#!/usr/bin/env node\nprocess.stdout.write("GitHub Copilot CLI 1.0.80\\n");\n',
      "utf8",
    );
    await chmod(executable, 0o755);
  }

  return { shim };
}

describe("resolveCopilotLaunchers", () => {
  test("always offers the configured path first", async () => {
    const launchers = await resolveCopilotLaunchers("/usr/bin/copilot");

    expect(launchers[0]).toEqual({
      command: "/usr/bin/copilot",
      prefixArgs: [],
    });
  });

  test("prefers the platform executable over the Node loader", async () => {
    const { shim } = await createNpmInstall({
      loader: true,
      platformBinary: true,
    });

    const launchers = await resolveCopilotLaunchers(shim);

    // The executable keeps the process tree flat, so a timeout kills the real
    // process instead of a wrapper.
    expect(launchers[1]?.command).toContain(PLATFORM_PACKAGE);
    expect(launchers[2]?.command).toBe(process.execPath);
  });

  test("falls back to the Node loader when no platform package is installed", async () => {
    const { shim } = await createNpmInstall({ loader: true });

    const launchers = await resolveCopilotLaunchers(shim);

    expect(launchers).toHaveLength(2);
    expect(launchers[1]).toEqual({
      command: process.execPath,
      prefixArgs: [expect.stringContaining("npm-loader.js")],
    });
  });

  test("offers nothing extra when the path is not an npm shim", async () => {
    const { shim } = await createNpmInstall({});

    expect(await resolveCopilotLaunchers(shim)).toHaveLength(1);
  });

  test("ignores a manifest whose named file is missing", async () => {
    const prefix = await mkdtemp(path.join(tmpdir(), "openwiki-npm-"));
    const dir = path.join(prefix, "node_modules", "@github", "copilot");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ bin: { copilot: "npm-loader.js" } }),
      "utf8",
    );

    expect(
      await resolveCopilotLaunchers(path.join(prefix, "copilot.cmd")),
    ).toHaveLength(1);
  });
});

describe("ensureCopilotAvailable", () => {
  test("recovers when the shim itself cannot be spawned", async () => {
    // This is the Windows failure: `copilot.cmd` is on PATH, Node refuses to
    // spawn it, and the real executable sits in node_modules beside it.
    const { shim } = await createNpmInstall({ platformBinary: true });

    const availability = await ensureCopilotAvailable({
      ...process.env,
      [COPILOT_CLI_BIN_ENV_KEY]: shim,
    });

    expect(availability.launcher.command).toContain(PLATFORM_PACKAGE);
    expect(availability.version).toContain("GitHub Copilot CLI");
  });

  test("falls through to the loader when only it can run", async () => {
    const { shim } = await createNpmInstall({ loader: true });

    const availability = await ensureCopilotAvailable({
      ...process.env,
      [COPILOT_CLI_BIN_ENV_KEY]: shim,
    });

    expect(availability.launcher.command).toBe(process.execPath);
    expect(availability.version).toContain("loader");
  });

  test("reports a missing install with the variable that fixes it", async () => {
    await expect(
      ensureCopilotAvailable({
        ...process.env,
        [COPILOT_CLI_BIN_ENV_KEY]: "/nonexistent/copilot",
      }),
    ).rejects.toThrow(/OPENWIKI_COPILOT_CLI_BIN/u);
  });
});
