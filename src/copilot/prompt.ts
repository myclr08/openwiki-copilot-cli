import path from "node:path";
import type { OpenWikiCommand } from "../agent/types.js";
import type { IndexedRepo, WorkspaceRepo } from "./types.js";

/** Inputs for one repository's Copilot prompt. */
export interface RepoPromptOptions {
  /** `init` writes the wiki from scratch; `update` refreshes an existing one. */
  command: Exclude<OpenWikiCommand, "chat">;

  /** The workspace brief (`INSTRUCTIONS.md`), when the user wrote one. */
  instructions?: string;

  /** Output language for the wiki prose, e.g. `"tr"`. */
  language?: string | null;

  /** The git head recorded by the previous run, for an incremental update. */
  previousGitHead?: string;

  repo: WorkspaceRepo;

  /** Extra guidance from the user for this run. */
  userMessage?: string | null;
}

/** Inputs for the cross-repository index prompt. */
export interface IndexPromptOptions {
  instructions?: string;

  language?: string | null;

  /**
   * Every repository the wiki documents, in index order. This is the complete
   * set, not the subset this run touched: the index is rewritten whole, so a
   * partial list would silently drop the repositories left out of it.
   */
  repos: IndexedRepo[];

  /** Absolute path to the workspace folder being documented. */
  workspaceRoot: string;
}

/**
 * The OKF front-matter contract, stated for an agent that writes files with
 * its own tools.
 *
 * OpenWiki repairs front matter deterministically after every run, so this is
 * guidance that improves the first draft rather than a hard requirement the
 * agent can fail.
 */
const FRONT_MATTER_RULES = `Front matter (Open Knowledge Format v0.2):
- Begin every concept page with YAML front matter delimited by --- lines.
- Required: \`type\`, a short human concept kind such as \`Service\`, \`API Endpoint\`, \`Workflow\`, or \`Reference\`.
- Recommended, in priority order: \`title\` (display name), \`description\` (one or two sentences, written for search and retrieval), \`tags\` (a YAML list of short facets).
- Never write a \`generated\` or \`timestamp\` field. OpenWiki stamps provenance itself after the run.
- \`index.md\` files are generated deterministically after the run. Do not create or edit any index.md.`;

/** Diagram rules; invalid fences are degraded to text after the run. */
const DIAGRAM_RULES = `Diagrams:
- Use fenced \`\`\`mermaid blocks for architecture, data flow, and sequence diagrams where a diagram genuinely explains more than prose.
- Keep the syntax valid and simple. Every invalid diagram is degraded to a plain text block after the run, which loses the picture.`;

/** Link rules; broken links are stamped in place after the run. */
const LINK_RULES = `Links:
- Link related pages with relative Markdown links, for example [Ingestion](./ingestion.md).
- Only link to pages you actually created. Broken links are stamped with an inline comment after the run.`;

/**
 * Builds the prompt for documenting one repository.
 *
 * The prompt is explicit about the two directories in play because Copilot runs
 * with the wiki directory as its working directory and reaches the source
 * through an `--add-dir` grant: the source repository is evidence, and the
 * working directory is the only place output belongs.
 */
export function buildRepoPrompt(options: RepoPromptOptions): string {
  const { repo } = options;
  const sections: string[] = [
    `You are OpenWiki, an expert technical writer and software architect. Document the repository at ${repo.path}.`,
    `Working rules:
- Your working directory is this repository's wiki directory. Write every page here, as Markdown.
- ${repo.path} is the source repository. Read it freely as evidence. Never create, edit, or delete anything inside it, and never run a command that changes it.
- Ground every claim in files you actually read. Do not invent modules, APIs, or behavior.
- Do not read or document secrets, credentials, tokens, private keys, or .env files.
- Prefer targeted search and short reads over reading large files end to end.`,
  ];

  sections.push(
    options.command === "init"
      ? buildInitWorkflow(repo)
      : buildUpdateWorkflow(repo, options.previousGitHead),
  );

  sections.push(FRONT_MATTER_RULES, DIAGRAM_RULES, LINK_RULES);

  const language = formatLanguageRule(options.language);
  if (language) sections.push(language);

  if (options.instructions?.trim()) {
    sections.push(
      `Workspace brief from the user. Treat it as scope and priority guidance:\n${options.instructions.trim()}`,
    );
  }

  if (options.userMessage?.trim()) {
    sections.push(
      `Additional request for this run:\n${options.userMessage.trim()}`,
    );
  }

  sections.push(
    "When you are done, reply with a two or three sentence summary of what the wiki now covers.",
  );

  return sections.join("\n\n");
}

/** The from-scratch workflow: map the repository, then write it up. */
function buildInitWorkflow(repo: WorkspaceRepo): string {
  return `Workflow:
1. Map the repository before writing prose. Inventory its manifests and workspaces, runtime and build entrypoints, public surfaces, major domains, data and schema ownership, existing docs, and representative tests.
2. Rank what matters by runtime importance, dependency centrality, public surface, and test ownership. Ranking sets the order you explore in, not whether something substantial gets covered.
3. Decide the page set and write it to _skeleton.md in your working directory, with a one-line description of what each page will cover. Group related files into coherent systems; do not mirror the directory tree.
4. Write every page in the skeleton. A passing mention or a directory listing is not coverage: explain responsibilities, owning entrypoints and symbols, relationships, invariants, and the tests that pin them down.
5. Write an overview page named overview.md that orients a newcomer: what ${path.basename(repo.path)} is, what it does, how it is structured, and where to start reading.
6. Reconcile the finished tree against your inventory and fill real gaps. Then delete _skeleton.md.

A reader should be able to understand this codebase from the wiki alone, without opening the source.`;
}

/** The incremental workflow: diff since the last run, then repair. */
function buildUpdateWorkflow(
  repo: WorkspaceRepo,
  previousGitHead: string | undefined,
): string {
  const diffHint = previousGitHead
    ? `Run \`git -C ${repo.path} log --oneline ${previousGitHead}..HEAD\` and \`git -C ${repo.path} diff --stat ${previousGitHead}..HEAD\` to see what changed since the last run.`
    : `Use \`git -C ${repo.path} log --oneline -50\` to see recent history; no previous run was recorded.`;

  return `Workflow:
1. Read the existing wiki in your working directory first so you know what is already documented.
2. ${diffHint}
3. Update the pages the changes affect. Add pages for genuinely new components; delete pages whose subject no longer exists.
4. Repair any inline OpenWiki comment marking a broken link, and correct anything the source now contradicts.
5. Leave accurate pages byte-for-byte alone. An update that rewrites unchanged prose creates diff noise for no gain.`;
}

/**
 * Builds the prompt for the cross-repository index: the one page that turns a
 * pile of per-repository wikis into a workspace wiki.
 */
export function buildIndexPrompt(options: IndexPromptOptions): string {
  const listing = options.repos
    .map((repo) =>
      repo.path ? `- ${repo.slug} — source at ${repo.path}` : `- ${repo.slug}`,
    )
    .join("\n");

  const sections = [
    `You are OpenWiki. Write the top-level index for a wiki covering every repository in ${options.workspaceRoot}.`,
    `Your working directory is the wiki root. It contains a repos/ directory with one wiki per repository. This list is complete, and the index must cover every entry on it — including any whose wiki was written by an earlier run:\n${listing}`,
    `Task:
1. Read repos/<slug>/index.md and repos/<slug>/overview.md for each repository to learn what it is.
2. Write index.md in your working directory. It must:
   - open with one paragraph describing what this collection of repositories is, taken together;
   - list every repository with a link to repos/<slug>/index.md and a one or two sentence description of what it does;
   - call out the relationships you can actually evidence between repositories — a shared API, a client and its server, a shared library, a common data store — and say what the evidence was;
   - stay honest about what you do not know. Do not assert a relationship you could not verify.
3. Write nothing else. Do not modify any page under repos/.`,
    `Front matter: begin index.md with YAML front matter containing \`okf_version: "0.2"\`, a \`title\`, and a \`description\`.`,
  ];

  const language = formatLanguageRule(options.language);
  if (language) sections.push(language);

  if (options.instructions?.trim()) {
    sections.push(
      `Workspace brief from the user:\n${options.instructions.trim()}`,
    );
  }

  return sections.join("\n\n");
}

/** States the output language, when one was requested. */
function formatLanguageRule(language: string | null | undefined): string {
  const trimmed = language?.trim();

  return trimmed
    ? `Language: write all prose in ${trimmed}. Keep code identifiers, file paths, and commands in their original form.`
    : "";
}
