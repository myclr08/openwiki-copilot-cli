/**
 * Types shared by the Copilot CLI backend.
 *
 * This backend does not drive a chat model. Copilot CLI is itself an agent that
 * owns its tool loop, so OpenWiki orchestrates it: discover repositories, build
 * prompts, run Copilot once per repository, then validate what it wrote.
 */

/** A repository discovered inside a workspace folder. */
export interface WorkspaceRepo {
  /** Absolute path to the repository root. */
  path: string;

  /**
   * Slug used for this repository's wiki section. Derived from the directory
   * name and unique within one workspace.
   */
  slug: string;
}

/** How one repository's run ended. */
export type RepoRunOutcome = "failed" | "skipped" | "succeeded";

/** The result of documenting one repository. */
export interface RepoRunResult {
  /** Paths inside the source repository that the run left modified. */
  dirtyPaths: string[];

  /** Failure message when {@link outcome} is `"failed"`. */
  error?: string;

  outcome: RepoRunOutcome;

  /** Why the repository was skipped, when {@link outcome} is `"skipped"`. */
  reason?: string;

  repo: WorkspaceRepo;
}

/** The result of one workspace run across every discovered repository. */
export interface WorkspaceRunResult {
  /** Whether the cross-repository index page was written. */
  indexWritten: boolean;

  results: RepoRunResult[];

  /** Absolute path to the wiki root the run wrote to. */
  wikiRoot: string;
}

/** One parsed line of Copilot CLI JSONL output. */
export interface CopilotSessionEvent {
  data?: Record<string, unknown>;
  ephemeral?: boolean;
  timestamp?: string;
  type: string;
}
