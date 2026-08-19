import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Cap on git output kept in memory; a status listing never approaches it. */
const MAX_BUFFER = 1024 * 1024;

/**
 * Runs a git command without letting an ordinary git failure end the run.
 *
 * A directory that is not a repository, a detached state, an unborn branch:
 * all of these are normal here, and every caller in this module treats an
 * empty result as "no information" rather than an error.
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      maxBuffer: MAX_BUFFER,
    });

    return stdout.trim();
  } catch {
    return "";
  }
}

/** The repository's current commit, or undefined when there is none. */
export async function getGitHead(cwd: string): Promise<string | undefined> {
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);

  return head.length > 0 ? head : undefined;
}

/**
 * Lists the repository's dirty paths, tracked and untracked.
 *
 * Comparing this before and after a run is how the backend proves the source
 * repository was left alone: Copilot is told the repository is read-only, and
 * this is the check that makes a violation visible instead of silent.
 */
export async function getDirtyPaths(cwd: string): Promise<string[]> {
  const status = await runGit(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);

  return status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();
}

/** Paths dirty after a run that were not already dirty before it. */
export function newlyDirtyPaths(before: string[], after: string[]): string[] {
  const known = new Set(before);

  return after.filter((entry) => !known.has(entry));
}
