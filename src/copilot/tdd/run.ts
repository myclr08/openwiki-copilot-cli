import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenWikiRunEvent } from "../../agent/types.js";
import {
  DEFAULT_COPILOT_CLI_MODEL,
  DEFAULT_WIKI_DIRECTORY,
} from "../config.js";
import { ensureCopilotAvailable } from "../detect.js";
import { runCopilot } from "../process.js";
import { askBrief, runInterview, type InterviewIo } from "./interview.js";
import { fetchJiraEvidence } from "./jira.js";
import {
  buildAnalysisPrompt,
  buildWritingPrompt,
  parseQuestions,
  type TddQuestion,
} from "./questions.js";
import { loadTddTemplate, validateTddDocument } from "./template.js";

/** Inputs for one TDD run. */
export interface TddRunOptions {
  workspaceRoot: string;
  jiraKey?: string | null;
  templatePath?: string | null;
  modelId?: string | null;
  outputFile?: string | null;
  onEvent?: (event: OpenWikiRunEvent) => void;
  io?: InterviewIo;
  env?: NodeJS.ProcessEnv;
}

/** What a finished run reports. */
export interface TddRunResult {
  /** The finished document — `--output` when given, else `<runDir>/tdd.md`. */
  documentPath: string;

  /** The run directory holding the document and its evidence files. */
  runDir: string;

  /** Validation findings: missing sections, leftover template placeholders. */
  warnings: string[];

  /** How many `[Netleştirilecek: …]` markers the document carries. */
  pendingClarifications: number;
}

/**
 * Produces the company TDD for one project: Jira evidence (optional) →
 * brief (optional) → analysis pass → terminal interview → writing pass →
 * validation.
 *
 * Copilot runs headless, so every interactive moment lives here, not in
 * Copilot. Evidence files persist in the run directory, which is what makes
 * a re-run cheap: an existing brief.md or questions.json is reused, and the
 * interview resumes past answered questions.
 */
export async function runTdd(options: TddRunOptions): Promise<TddRunResult> {
  const env = options.env ?? process.env;
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const wikiDir = path.join(workspaceRoot, DEFAULT_WIKI_DIRECTORY);

  if (!(await exists(wikiDir))) {
    throw new Error(
      `No wiki found at ${wikiDir}. Run \`openwiki workspace ${options.workspaceRoot}\` first — the TDD is grounded in that wiki.`,
    );
  }

  const { launcher } = await ensureCopilotAvailable(env);
  const model = options.modelId?.trim() || DEFAULT_COPILOT_CLI_MODEL;
  const { raw: templateRaw, template } = await loadTddTemplate(
    options.templatePath,
  );

  const jiraKey = options.jiraKey?.trim() || undefined;
  const runName = jiraKey ?? `adhoc-${localDateStamp()}`;
  const runDir = path.join(workspaceRoot, "tdd", runName);

  const emit = (text: string) => options.onEvent?.({ type: "text", text });

  // 1. Jira evidence. Always refetched when a key is given: fresh evidence
  // beats a stale copy, and the fetch is cheap next to a Copilot pass. Runs
  // before the run directory is created, so a failed fetch (e.g. missing
  // credentials) leaves no empty directory behind.
  let unreadableAttachments: string[] = [];
  let jiraMarkdown: string | undefined;

  if (jiraKey) {
    emit(`Jira ${jiraKey} okunuyor…`);
    const evidence = await fetchJiraEvidence(jiraKey, env);
    jiraMarkdown = evidence.markdown;
    unreadableAttachments = evidence.unreadableAttachments;

    if (unreadableAttachments.length > 0) {
      emit(
        `Okunamayan ekler (mülakatta sorulacak): ${unreadableAttachments.join(", ")}`,
      );
    }
  }

  await mkdir(runDir, { recursive: true });

  if (jiraMarkdown !== undefined) {
    await writeFile(path.join(runDir, "jira.md"), jiraMarkdown, "utf8");
  }

  // 2. Brief — asked once; an existing brief.md (a resumed run) is kept. A
  // skipped brief still writes an empty file, so the prompt is not asked
  // again on the next run.
  const briefFile = path.join(runDir, "brief.md");

  if (!(await exists(briefFile))) {
    const brief = await askBrief(options.io);
    await writeFile(briefFile, brief ? `${brief}\n` : "", "utf8");
  }

  const hasJira = await exists(path.join(runDir, "jira.md"));
  const hasBrief = (await readFile(briefFile, "utf8")).trim().length > 0;

  // 3. Analysis pass → questions.json. An existing file (a resumed run)
  // skips the pass entirely.
  const questionsFile = path.join(runDir, "questions.json");
  let questions: TddQuestion[];

  if (await exists(questionsFile)) {
    questions = parseQuestions(await readFile(questionsFile, "utf8"));
    emit(`Sorular questions.json'dan yüklendi (${questions.length}).`);
  } else {
    emit("Analiz geçişi: Copilot wiki'yi ve kanıtları okuyor…");
    const analysis = await runCopilot({
      cwd: runDir,
      addDirs: [wikiDir],
      launcher,
      model,
      env,
      prompt: buildAnalysisPrompt({
        template,
        hasJira,
        hasBrief,
        unreadableAttachments,
        wikiDir,
      }),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });

    if (analysis.fatalError) {
      throw new Error(`The analysis pass failed: ${analysis.fatalError}`);
    }

    // The prompt asks for questions.json; the assistant text is the fallback
    // when the model answered inline instead of writing the file.
    const rawQuestions =
      (await readFile(questionsFile, "utf8").catch(() => undefined)) ??
      analysis.text;
    questions = parseQuestions(rawQuestions);
    await writeFile(
      questionsFile,
      `${JSON.stringify(questions, null, 2)}\n`,
      "utf8",
    );
  }

  // 4. Interview — answers persist per question; resume skips answered ones.
  const answersFile = path.join(runDir, "answers.md");
  const { answered, skipped } = await runInterview(
    questions,
    answersFile,
    options.io,
  );
  emit(`Mülakat: ${answered} cevap, ${skipped} geç.`);

  // 5. Writing pass → tdd.md, then validation (reports, never rewrites).
  emit("Yazım geçişi: TDD dolduruluyor…");
  const writing = await runCopilot({
    cwd: runDir,
    addDirs: [wikiDir],
    launcher,
    model,
    env,
    prompt: buildWritingPrompt({
      templateRaw,
      hasJira,
      hasBrief,
      wikiDir,
      today: formatToday(),
    }),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  if (writing.fatalError) {
    throw new Error(`The writing pass failed: ${writing.fatalError}`);
  }

  const documentFile = path.join(runDir, "tdd.md");
  const document = await readFile(documentFile, "utf8").catch(() => undefined);

  if (document === undefined) {
    throw new Error(
      "The writing pass did not produce tdd.md. Re-run to retry — the evidence and answers are kept.",
    );
  }

  const { warnings, pendingClarifications } = validateTddDocument(
    template,
    document,
  );

  let documentPath = documentFile;

  if (options.outputFile) {
    documentPath = path.resolve(options.outputFile);
    await mkdir(path.dirname(documentPath), { recursive: true });
    await copyFile(documentFile, documentPath);
  }

  return { documentPath, runDir, warnings, pendingClarifications };
}

/** Today as DD/MM/YYYY, the template's Tarih format. */
function formatToday(now = new Date()): string {
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");

  return `${day}/${month}/${now.getFullYear()}`;
}

/**
 * Today as local YYYY-MM-DD, for the adhoc run directory name. Must agree
 * with `formatToday()`'s local date source — otherwise a run started and
 * resumed on the same local day can land in different directories whenever
 * local time and UTC disagree on which day it is.
 */
function localDateStamp(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/** Whether a path exists. */
async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined)) !== undefined;
}
