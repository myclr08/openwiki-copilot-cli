import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceRepo } from "./types.js";

/**
 * Directory names never treated as repositories. These show up inside a
 * workspace folder often enough that scanning them would produce noise
 * sections in the wiki.
 */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "target",
  "vendor",
  "venv",
]);

/** Options for {@link discoverRepos}. */
export interface DiscoverReposOptions {
  /**
   * Directory excluded from discovery, normally the wiki output root when it
   * sits inside the workspace. Without this a run would document its own
   * output on the next pass.
   */
  excludeDir?: string;

  /** Repository names or slugs to keep; empty or absent keeps everything. */
  only?: string[];
}

/**
 * Finds the repositories to document inside a workspace folder.
 *
 * Direct children that contain a `.git` entry are the repositories. When the
 * folder holds no git repositories at all, every eligible child directory is
 * used instead, so a folder of plain source checkouts still works. The
 * workspace root itself is used when it is a repository, which makes
 * single-repo runs a special case of the same code path.
 *
 * Results are sorted by slug so a run's order — and its index page — is stable.
 */
export async function discoverRepos(
  root: string,
  options: DiscoverReposOptions = {},
): Promise<WorkspaceRepo[]> {
  const absoluteRoot = path.resolve(root);
  const rootStat = await stat(absoluteRoot).catch(() => undefined);

  if (!rootStat?.isDirectory()) {
    throw new Error(`Workspace folder not found: ${absoluteRoot}`);
  }

  if (await isGitRepo(absoluteRoot)) {
    return applyFilter([toRepo(absoluteRoot)], options.only);
  }

  const excluded = options.excludeDir
    ? path.resolve(options.excludeDir)
    : undefined;
  const candidates: string[] = [];

  for (const entry of await readdir(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;

    const candidate = path.join(absoluteRoot, entry.name);

    if (excluded && (candidate === excluded || isInside(excluded, candidate))) {
      continue;
    }

    // A symlinked entry is only usable if it resolves to a directory.
    if (entry.isSymbolicLink()) {
      const target = await stat(candidate).catch(() => undefined);
      if (!target?.isDirectory()) continue;
    }

    candidates.push(candidate);
  }

  const gitRepos: string[] = [];

  for (const candidate of candidates) {
    if (await isGitRepo(candidate)) gitRepos.push(candidate);
  }

  const selected = gitRepos.length > 0 ? gitRepos : candidates;

  return applyFilter(assignSlugs(selected), options.only);
}

/** Reports whether a directory is a git repository or worktree. */
export async function isGitRepo(directory: string): Promise<boolean> {
  // A worktree's .git is a file pointing at the real git dir, so both a
  // directory and a file count.
  return (
    (await stat(path.join(directory, ".git")).catch(() => undefined)) !==
    undefined
  );
}

/**
 * Converts a directory name into a wiki-safe slug: lowercase, with runs of
 * non-alphanumeric characters collapsed to single hyphens.
 */
export function toSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return slug || "repo";
}

/** Builds repos with slugs that are unique within one workspace. */
function assignSlugs(directories: string[]): WorkspaceRepo[] {
  const used = new Set<string>();

  return directories.map((directory) => {
    const base = toSlug(path.basename(directory));
    let slug = base;
    let suffix = 2;

    while (used.has(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }

    used.add(slug);

    return { path: directory, slug };
  });
}

/** Builds a single repo entry for a directory. */
function toRepo(directory: string): WorkspaceRepo {
  return { path: directory, slug: toSlug(path.basename(directory)) };
}

/**
 * Restricts discovery to the requested names. Matching accepts either the
 * directory name or the generated slug, so `--only My_Api` and `--only my-api`
 * both work.
 */
function applyFilter(
  repos: WorkspaceRepo[],
  only: string[] | undefined,
): WorkspaceRepo[] {
  const wanted = (only ?? []).map((name) => toSlug(name)).filter(Boolean);

  if (wanted.length === 0) return sortBySlug(repos);

  const selected = repos.filter(
    (repo) =>
      wanted.includes(repo.slug) ||
      wanted.includes(toSlug(path.basename(repo.path))),
  );

  const missing = wanted.filter(
    (name) =>
      !repos.some(
        (repo) =>
          repo.slug === name || toSlug(path.basename(repo.path)) === name,
      ),
  );

  if (missing.length > 0) {
    throw new Error(
      `No repository matched: ${missing.join(", ")}. Available: ${
        repos.map((repo) => repo.slug).join(", ") || "none"
      }.`,
    );
  }

  return sortBySlug(selected);
}

/** Sorts repos by slug so run order and index order stay deterministic. */
function sortBySlug(repos: WorkspaceRepo[]): WorkspaceRepo[] {
  return [...repos].sort((left, right) => left.slug.localeCompare(right.slug));
}

/** Reports whether `child` sits inside `parent`. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}
