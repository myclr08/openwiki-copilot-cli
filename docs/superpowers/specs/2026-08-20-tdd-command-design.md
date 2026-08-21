# `openwiki tdd` — Filling the Company Technical Design Template — Design

Date: 2026-08-20
Status: approved

## Problem

The company writes an "MVP - Teknik Detay" page for every development
project: a nine-section Confluence page covering scope, affected
applications, frontend and backend work, ROTA flows, database changes,
operational definitions, approvals, and diagram status. Writing it well
requires knowing both what the project is (the Jira record, the developer's
head) and how the existing systems fit together (which is exactly what the
`openwiki workspace` wiki now captures).

`openwiki tdd` turns that into a repeatable pipeline: Copilot CLI reads the
workspace wiki, the Jira record when one is given, and the developer's
answers, and fills the company template.

## Decisions already made

These were settled in the design conversation and are fixed inputs to this
spec:

- Repeatable tool feature in this fork, not a one-off document.
- Jira is **optional**. A given issue key brings Jira reading into the run;
  without one the developer interview carries the full weight.
- Jira auth is a profile **Personal Access Token** sent as a Bearer header
  (Server/DC style). No basic-auth or Cloud email path.
- Developer knowledge enters in two steps: an optional free-form brief at
  the start, then a live terminal interview with generated questions.
- Output is **Markdown**, written in **Turkish** (the template's language),
  pasted into Confluence by the developer. Confluence's editor converts
  pasted Markdown; Insert → Markup → Markdown is the fallback.
- Only the MVP detail page is generated. The master TDD and its diagrams
  live in Confluence and stay human-owned; section 9 is filled with
  statements the developer completes there.

## Command

```
openwiki tdd <workspace-folder> [--jira DNZ-1111] [--template <file.md>]
             [--model <id>] [--output <file>]
```

Environment (read from the shell or `~/.openwiki/.env`, which the CLI
already loads for workspace-family commands):

```
OPENWIKI_JIRA_BASE_URL   e.g. https://jira.company.com
OPENWIKI_JIRA_TOKEN      profile PAT, sent as "Authorization: Bearer …"
```

Preflight requires two things and stops with an actionable message when
either is missing: a runnable Copilot CLI (the existing launcher
resolution, Windows shim handling included) and a workspace wiki
(`<workspace>/openwiki/`); without the wiki the message says to run
`openwiki workspace <folder>` first.

## Flow

Five steps, run by the OpenWiki orchestrator. Copilot runs headless
(`--no-ask-user`), so every interactive moment belongs to OpenWiki, not
Copilot.

### 1. Jira evidence (only with `--jira`)

Fetched over REST with the Bearer PAT: the issue's summary, description,
acceptance criteria, **comments** (decisions often live there), subtasks,
and issue links. Everything lands in one evidence file, `jira.md`.

Attachments are downloaded and handled by format:

| Attachment                          | Handling                          |
| ----------------------------------- | --------------------------------- |
| `.txt`, `.md`, `.csv`               | Included in the evidence directly |
| PDF                                 | Text extracted, included          |
| Word (`.docx`)                      | Text extracted, included          |
| Images, Excel, Visio, anything else | Listed by filename only           |

Unreadable attachments are not silently dropped: the analysis pass sees
the filename list and generates an interview question about any that look
relevant ("the record has `odeme-akisi.png` attached — can you summarize
that flow?"), so the content reaches the evidence through the developer's
answer.

Linked Confluence pages are **not fetched** in v1. They are listed in
`jira.md`, and the interview may ask about them. Fetching them would need
a second API and separate permissions; it is a candidate for a later
version, not this one.

An unreachable Jira, a bad token, or an unknown issue key fails the run
immediately with the HTTP status and the URL that failed — before any
Copilot run starts. No `--jira` flag means this step is skipped silently.

### 2. Brief (optional)

The terminal asks once: describe the project in a few sentences, or press
Enter to skip. Whatever is given lands in `brief.md`.

### 3. Analysis pass (Copilot, headless)

Copilot reads the workspace wiki, `jira.md`, `brief.md`, and the template's
section structure, and emits structured questions as JSON:
`[{section, question, why}]`.

The governing rule, stated in the prompt: **never ask what the wiki can
answer.** Questions target only tacit knowledge, weighted toward the
project's business flow, and fall into four clusters: business flow (the
core), scope and boundaries, technical choices the wiki cannot decide
(sync/async, new table vs. new column), and constraints (performance,
authorization, dates) where the template has a section for them.

The JSON is parsed tolerantly — Copilot output is model output. A reply
that yields no parseable questions aborts with the raw output shown,
rather than inventing an empty interview.

### 4. Interview (terminal, incremental persistence)

Questions are asked one at a time in the terminal. Every answer is
appended to `answers.md` **immediately**, so an interrupted session loses
nothing. Typing `geç` skips a question; a skipped question surfaces in the
document as `[Netleştirilecek: …]` instead of a fabricated answer.

On a re-run, an existing `answers.md` is loaded and questions that already
have answers are not asked again.

### 5. Writing pass (Copilot, headless) + validation

Copilot fills the template from all evidence. Rules stated in the prompt:

- A section with no work in this project gets `Kapsam Dışı`, per the
  template's own convention.
- **No invention.** Every endpoint, table, saga, and flow named in the
  document must be grounded in the wiki, the Jira evidence, or an
  interview answer. What is not known stays `[Netleştirilecek: …]`.
- The template's `Açıklama` notes are filling instructions, not content —
  they never appear in the output (the template itself says to delete
  them).
- Prose in Turkish; identifiers, paths, and endpoint names as-is.

A deterministic pass then checks the result: all nine sections present,
no unfilled `[...]` placeholder left from the template itself, and reports
what it found. Validation reports; it does not silently rewrite.

## Output layout

```
<workspace>/tdd/<jira-key-or-name>/
  tdd.md        ← the page to paste into Confluence
  jira.md       ← evidence: the Jira record
  brief.md      ← evidence: the developer's brief
  answers.md    ← record: the interview Q&A
```

The directory is named by the Jira key when one was given, otherwise
`adhoc-<YYYY-MM-DD>`, so two keyless runs on different days never collide
and a same-day re-run resumes its predecessor's answers. `--output` overrides where `tdd.md` is
written; the evidence files stay with the run directory. The TDD is not
wiki content: it gets no OKF front matter and lives outside `openwiki/`.

## Template handling

A Markdown mirror of the company PDF ships in the package as the default
template, structured as: the nine numbered sections, each with its
`Açıklama` filling note attached as instruction metadata. `--template`
substitutes any other Markdown file with the same shape, so the company
template can evolve without a new release.

## Modules

New code sits beside the existing Copilot backend and reuses its runner,
launcher resolution, and event bridge unchanged:

| Module                         | Responsibility                                                       |
| ------------------------------ | -------------------------------------------------------------------- |
| `src/copilot/tdd/jira.ts`      | Fetch issue, comments, subtasks, links, attachments; write `jira.md` |
| `src/copilot/tdd/extract.ts`   | Text extraction from PDF and DOCX attachments                        |
| `src/copilot/tdd/template.ts`  | Bundled template, `--template` loading, section model                |
| `src/copilot/tdd/questions.ts` | Analysis-pass prompt; tolerant JSON parsing of the question list     |
| `src/copilot/tdd/interview.ts` | Terminal Q&A loop; incremental `answers.md`; resume                  |
| `src/copilot/tdd/run.ts`       | Orchestration of the five steps; validation; summary                 |
| `src/cli/tdd-command.ts`       | Argument parsing, following `workspace-command.ts`                   |

Attachment extraction adds one small pure-JS, no-network dependency for
PDF text extraction. DOCX (a ZIP of XML) is read with a minimal in-repo
ZIP entry reader on `node:zlib` — company policy bars the usual archive
packages, and the need is one named entry, stored or deflated. The
constraint — pure JS, no network access, no native build step — binds any
future dependency here too.

## Error handling

- Jira failures stop the run before Copilot starts, with status and URL.
- A Copilot fatal error in either pass stops the run with the error and a
  non-zero exit; evidence files written so far are kept, so a re-run
  resumes cheaply (brief and answers are not re-asked).
- An interview interrupted by Ctrl-C leaves `answers.md` intact; the next
  run continues from the first unanswered question.
- Validation problems (missing section, leftover placeholder) are printed
  as warnings; the document is still written. Judging whether it is good
  enough to paste is the developer's call, not the tool's.

## Testing

Against the existing stub-Copilot harness plus a local fake Jira:

- Jira module against a localhost HTTP server: happy path, bad token,
  missing issue, attachment download and per-format handling.
- Question JSON parsing: valid, fenced-in-markdown, malformed, empty.
- Interview loop with scripted stdin: answers persisted per question,
  `geç`, resume from a partial `answers.md`.
- Writing pass wiring via the stub binary: evidence files reach the
  prompt, `Kapsam Dışı` rule stated, template override respected.
- Validation: all-sections check, placeholder detection.

## Non-goals (v1)

- Fetching or publishing Confluence pages (paste is manual by design).
- Interpreting image attachments — routed through the interview instead.
- Generating the master TDD or its diagrams.
- Any output language other than Turkish.
