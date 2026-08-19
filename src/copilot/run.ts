import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  OpenWikiCommand,
  OpenWikiRunEvent,
  UpdateMetadata,
} from "../agent/types.js";
import {
  DEFAULT_COPILOT_CLI_MODEL,
  DEFAULT_WIKI_DIRECTORY,
  REPOS_DIRECTORY,
} from "./config.js";
import { ensureCopilotAvailable } from "./detect.js";
import { getDirtyPaths, getGitHead, newlyDirtyPaths } from "./git.js";
import {
  canSkipUpdate,
  readRepoMetadata,
  writeRepoMetadata,
} from "./metadata.js";
import { postProcessWiki } from "./postprocess.js";
import { buildIndexPrompt, buildRepoPrompt } from "./prompt.js";
import { runCopilot } from "./process.js";
import { discoverRepos } from "./workspace.js";
import type {
  RepoRunResult,
  WorkspaceRepo,
  WorkspaceRunResult,
} from "./types.js";

/** The workspace brief a user can drop beside the wiki. */
export const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

/** Inputs for one workspace run. */
export interface WorkspaceRunOptions {
  /** `init` writes wikis from scratch; `update` refreshes them. */
  command: Exclude<OpenWikiCommand, "chat">;

  language?: string | null;

  /** Copilot model id. Falls back to the backend default. */
  modelId?: string | null;

  onEvent?: (event: OpenWikiRunEvent) => void;

  /** Repository names or slugs to limit the run to. */
  only?: string[];

  /** Wiki output root. Defaults to `openwiki/` inside the workspace. */
  outputDir?: string | null;

  signal?: AbortSignal;

  /** Extra guidance passed through to every repository's prompt. */
  userMessage?: string | null;

  /** The folder holding the repositories to document. */
  workspaceRoot: string;
}

/**
 * Documents every repository in a workspace folder with Copilot CLI.
 *
 * Repositories run one at a time. That is the point rather than a limitation:
 * a failure stays attributed to one repository, progress is legible in the run
 * log, and a workspace of any size makes steady progress instead of hitting
 * rate limits in parallel.
 *
 * The source repositories are never written to. Copilot runs with the wiki
 * directory as its working directory and reaches the source through an
 * `--add-dir` grant, and each repository's dirty paths are compared before and
 * after so a violation is reported rather than missed.
 */
export async function runCopilotWorkspace(
  options: WorkspaceRunOptions,
): Promise<WorkspaceRunResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const wikiRoot = resolveWikiRoot(workspaceRoot, options.outputDir);
  const model = options.modelId?.trim() || DEFAULT_COPILOT_CLI_MODEL;

  const availability = await ensureCopilotAvailable();
  emit(options, {
    type: "debug",
    message: `copilot.binary=${availability.binary} version=${availability.version}`,
  });

  const repos = await discoverRepos(workspaceRoot, {
    excludeDir: wikiRoot,
    ...(options.only ? { only: options.only } : {}),
  });

  if (repos.length === 0) {
    throw new Error(
      `No repositories found in ${workspaceRoot}. Point --workspace at a folder that contains repository directories.`,
    );
  }

  await mkdir(path.join(wikiRoot, REPOS_DIRECTORY), { recursive: true });
  const instructions = await readInstructions(wikiRoot);

  emit(options, {
    type: "text",
    text: `Documenting ${repos.length} ${repos.length === 1 ? "repository" : "repositories"} from ${workspaceRoot} into ${wikiRoot} with ${model}.`,
  });

  const results: RepoRunResult[] = [];

  for (const repo of repos) {
    if (options.signal?.aborted) break;

    results.push(
      await runRepo({
        instructions,
        model,
        options,
        repo,
        wikiRoot,
      }),
    );
  }

  const documented = results.filter((result) => result.outcome !== "failed");
  const indexWritten =
    (await shouldWriteIndex(results, wikiRoot)) && !options.signal?.aborted
      ? await writeCrossRepoIndex({
          instructions,
          model,
          options,
          repos: documented.map((result) => result.repo),
          wikiRoot,
          workspaceRoot,
        })
      : false;

  return { indexWritten, results, wikiRoot };
}

/** Inputs shared by the per-repository step. */
interface RepoStepOptions {
  instructions: string | undefined;
  model: string;
  options: WorkspaceRunOptions;
  repo: WorkspaceRepo;
  wikiRoot: string;
}

/** Documents one repository, returning its outcome instead of throwing. */
async function runRepo({
  instructions,
  model,
  options,
  repo,
  wikiRoot,
}: RepoStepOptions): Promise<RepoRunResult> {
  const wikiDir = path.join(wikiRoot, REPOS_DIRECTORY, repo.slug);
  const gitHead = await getGitHead(repo.path);

  if (options.command === "update") {
    const metadata = await readRepoMetadata(wikiDir);

    if (canSkipUpdate(metadata, gitHead, options.language)) {
      emit(options, {
        type: "text",
        text: `${repo.slug}: unchanged since the last run, skipping.`,
      });

      return { dirtyPaths: [], outcome: "skipped", reason: "unchanged", repo };
    }
  }

  await mkdir(wikiDir, { recursive: true });
  emit(options, { type: "text", text: `${repo.slug}: reading ${repo.path}` });

  const dirtyBefore = await getDirtyPaths(repo.path);

  try {
    const result = await runCopilot({
      addDirs: [repo.path],
      cwd: wikiDir,
      model,
      prompt: buildRepoPrompt({
        command: options.command,
        repo,
        ...(instructions ? { instructions } : {}),
        ...(options.language ? { language: options.language } : {}),
        ...(options.userMessage ? { userMessage: options.userMessage } : {}),
        ...(await resolvePreviousHead(options.command, wikiDir)),
      }),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const dirtyPaths = newlyDirtyPaths(
      dirtyBefore,
      await getDirtyPaths(repo.path),
    );

    if (dirtyPaths.length > 0) {
      emit(options, {
        type: "text",
        text: `${repo.slug}: warning — the run modified ${dirtyPaths.length} path(s) in the source repository: ${dirtyPaths.slice(0, 10).join(", ")}`,
      });
    }

    if (result.fatalError) {
      await recordRun(wikiDir, options, model, gitHead, "interrupted");

      return {
        dirtyPaths,
        error: result.fatalError,
        outcome: "failed",
        repo,
      };
    }

    const report = await postProcessWiki(wikiDir, options.language);
    emit(options, {
      type: "debug",
      message: `copilot.postprocess repo=${repo.slug} mermaidDegraded=${report.mermaid.fencesDegraded} brokenLinks=${report.links.issuesFound}`,
    });

    await recordRun(wikiDir, options, model, gitHead, "complete");

    return { dirtyPaths, outcome: "succeeded", repo };
  } catch (error) {
    return {
      dirtyPaths: [],
      error: error instanceof Error ? error.message : String(error),
      outcome: "failed",
      repo,
    };
  }
}

/** Inputs for the cross-repository index step. */
interface IndexStepOptions {
  instructions: string | undefined;
  model: string;
  options: WorkspaceRunOptions;
  repos: WorkspaceRepo[];
  wikiRoot: string;
  workspaceRoot: string;
}

/**
 * Writes the wiki root's index page.
 *
 * Unlike the per-repository directories, the root index is not generated
 * deterministically: describing how separate repositories relate to each other
 * is a judgment the agent has to make from their wikis, so Copilot writes it.
 * A failure here is reported but does not fail the workspace — the per-repo
 * wikis are the substance, and the index can be regenerated on the next run.
 */
async function writeCrossRepoIndex({
  instructions,
  model,
  options,
  repos,
  wikiRoot,
  workspaceRoot,
}: IndexStepOptions): Promise<boolean> {
  emit(options, { type: "text", text: "Writing the cross-repository index." });

  try {
    const result = await runCopilot({
      cwd: wikiRoot,
      model,
      prompt: buildIndexPrompt({
        repos,
        workspaceRoot,
        ...(instructions ? { instructions } : {}),
        ...(options.language ? { language: options.language } : {}),
      }),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (result.fatalError) {
      emit(options, {
        type: "text",
        text: `The cross-repository index could not be written: ${result.fatalError}`,
      });

      return false;
    }

    return true;
  } catch (error) {
    emit(options, {
      type: "text",
      text: `The cross-repository index could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });

    return false;
  }
}

/** Records the run marker for one repository's wiki. */
async function recordRun(
  wikiDir: string,
  options: WorkspaceRunOptions,
  model: string,
  gitHead: string | undefined,
  status: UpdateMetadata["status"],
): Promise<void> {
  await writeRepoMetadata(wikiDir, {
    command: options.command,
    model,
    status,
    updatedAt: new Date().toISOString(),
    ...(gitHead ? { gitHead } : {}),
    ...(options.language?.trim() ? { language: options.language.trim() } : {}),
  });
}

/** Supplies the previous run's commit so an update can diff against it. */
async function resolvePreviousHead(
  command: Exclude<OpenWikiCommand, "chat">,
  wikiDir: string,
): Promise<{ previousGitHead?: string }> {
  if (command !== "update") return {};

  const metadata = await readRepoMetadata(wikiDir);

  return metadata?.gitHead ? { previousGitHead: metadata.gitHead } : {};
}

/**
 * Decides whether the cross-repository index needs rewriting.
 *
 * An update where every repository was skipped cannot have changed the index,
 * so re-deriving it would spend a Copilot run to reproduce the page that is
 * already there. It still runs when the page is missing, which covers a first
 * run and an index deleted by hand.
 */
async function shouldWriteIndex(
  results: RepoRunResult[],
  wikiRoot: string,
): Promise<boolean> {
  if (results.some((result) => result.outcome === "succeeded")) return true;
  if (!results.some((result) => result.outcome === "skipped")) return false;

  return !(await readFile(path.join(wikiRoot, "index.md"), "utf8").catch(
    () => undefined,
  ));
}

/** Resolves the wiki root, defaulting to `openwiki/` inside the workspace. */
export function resolveWikiRoot(
  workspaceRoot: string,
  outputDir: string | null | undefined,
): string {
  const requested = outputDir?.trim();

  return requested
    ? path.resolve(requested)
    : path.join(workspaceRoot, DEFAULT_WIKI_DIRECTORY);
}

/** Reads the optional workspace brief from the wiki root. */
async function readInstructions(wikiRoot: string): Promise<string | undefined> {
  try {
    const content = await readFile(
      path.join(wikiRoot, INSTRUCTIONS_FILE),
      "utf8",
    );

    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Forwards an event to the caller when one is listening. */
function emit(options: WorkspaceRunOptions, event: OpenWikiRunEvent): void {
  options.onEvent?.(event);
}
