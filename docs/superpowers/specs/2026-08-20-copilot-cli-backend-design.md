# OpenWiki on GitHub Copilot CLI — Design

Date: 2026-08-20
Status: approved

## Problem

OpenWiki generates a wiki for one repository using a DeepAgents/LangChain
documentation agent driven by a hosted model provider. Two things are needed
that it does not do today:

1. Run on **GitHub Copilot CLI** instead of a hosted model API.
2. Document a **folder of repositories** in one pass, not a single repo.

## Constraint that shapes everything

Copilot CLI is not a model API. It is an agent with its own tools (file read
and write, shell, search) and it does not accept externally supplied tool
schemas. It cannot be dropped into `createModel()` as a `BaseChatModel`
because DeepAgents drives the tool loop and Copilot will not give up that
loop.

So the roles invert. With this backend OpenWiki is the **orchestrator**: it
discovers repositories, builds prompts, spawns Copilot per repository, and
validates what comes back. Copilot does the reading and writing.

## Architecture

### Engine branch

`runOpenWikiAgent()` (`src/agent/index.ts`) branches early. When the resolved
provider is `copilot-cli`, the LangChain model, DeepAgents graph, and
checkpointer are never constructed; control passes to the Copilot
orchestrator. Every other provider keeps its existing path untouched.

### Event bridge

Copilot's `--output-format json` emits JSONL. `src/copilot/events.ts` maps
those lines onto the existing `OpenWikiRunEvent` union (`text`, `tool_start`,
`tool_end`, `debug`). The Ink UI, run log, and telemetry consume the same
events they always have, so none of them change.

Unknown or malformed lines degrade to a `debug` event. A JSONL schema change
upstream must never crash a run.

### Modules

| Module | Responsibility |
| --- | --- |
| `src/copilot/detect.ts` | Locate the binary (`COPILOT_CLI_BIN` override), preflight version and entitlement |
| `src/copilot/events.ts` | Parse JSONL into `OpenWikiRunEvent`; tolerate unknown shapes |
| `src/copilot/process.ts` | Spawn `copilot -p`, stream stdout, handle exit codes, timeout, cancellation |
| `src/copilot/prompt.ts` | Build the Copilot prompt from OpenWiki's existing code-mode prompts plus OKF, Mermaid, and link rules |
| `src/copilot/workspace.ts` | Discover git repositories under a root folder |
| `src/copilot/run.ts` | Orchestrate: sequential per-repo runs, post-processing, cross-repo merge |

Each module has one job and is testable without a real Copilot binary.

## Output layout

The workspace is never written to. Output goes to one central wiki:

```
<workspace>/openwiki/
  index.md                 cross-repo index
  repos/<repo-name>/
    index.md
    <topic>.md
```

`--output <dir>` moves the wiki anywhere, including outside the workspace.

## Repository safety

Repositories are inputs, not outputs.

- Copilot runs with `cwd` set to the repo's wiki output directory.
- Read access to the source repo comes from `--add-dir <repo>`.
- `--allow-all-tools` only. Never `--allow-all` or `--allow-all-paths`.
- The prompt states that the source repository is read-only.
- `git status --porcelain` is captured before and after each repo run. A
  changed repo produces a warning naming the files, so a prompt-following
  failure is visible rather than silent.

## Run flow

Per repository, sequentially:

1. Build the prompt for the command (`init` or `update`).
2. Spawn Copilot; stream events to the UI.
3. Validate the output with the existing passes: Mermaid
   (`src/mermaid/validate.ts`), wiki links
   (`src/agent/wiki-link-validator.ts`), OKF frontmatter and index sync
   (`src/okf/`).
4. Write `.last-update.json` for that repository.

Then one merge run at the wiki root writes the cross-repo `index.md` from the
per-repo indexes.

On `update`, a repository whose git HEAD matches its recorded
`.last-update.json` is skipped, mirroring the existing no-op path.

## Error handling

A failing repository does not stop the workspace run. Failures are collected
and reported in a summary (`3 succeeded, 1 failed`), and the process exit code
is non-zero when any repository failed.

A missing or unauthorized Copilot binary fails preflight with an actionable
message before any repository is touched.

## CLI

```
openwiki workspace <folder>                  generate wikis for every repo
openwiki workspace <folder> --update         refresh only changed repos
openwiki workspace <folder> --output <dir>   choose the wiki location
openwiki workspace <folder> --only a,b       limit to named repos
openwiki workspace <folder> --model <id>     pick the Copilot model
```

## Testing

Tests run against a stub binary supplied through `COPILOT_CLI_BIN` that
replays recorded JSONL fixtures, so the suite needs no Copilot entitlement and
is deterministic.

Covered: repository discovery, JSONL to event mapping including malformed
input, prompt construction, argument construction, output layout, the
repo-dirty guard, update skipping, and failure aggregation.

## Known limitation

The account available during development is refused by Copilot policy
(`Access denied by policy settings`), so the integration is verified against
the stub and by inspection of Copilot's documented CLI contract, not against
live Copilot. This is stated in the README rather than papered over.
