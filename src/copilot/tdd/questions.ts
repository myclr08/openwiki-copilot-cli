import type { TddTemplate } from "./template.js";

/** One interview question produced by the analysis pass. */
export interface TddQuestion {
  /** The template section the question serves, e.g. "5. ROTA Akış İşlemleri". */
  section: string;

  /** The question itself, in Turkish. */
  question: string;

  /** Why the answer is needed — shown to the developer for context. */
  why?: string;
}

/** More questions than this is an interrogation, not an interview. */
const MAX_QUESTIONS = 25;

/** Inputs for the analysis-pass prompt. */
export interface AnalysisPromptOptions {
  template: TddTemplate;
  hasJira: boolean;
  hasBrief: boolean;
  unreadableAttachments: string[];
  wikiDir: string;
}

/**
 * Builds the analysis-pass prompt: read the evidence, find what only the
 * developer can answer, and write it as structured questions.
 *
 * The governing rule is stated verbatim — never ask what the wiki can
 * answer — because it is the whole difference between an interview that
 * extracts tacit knowledge and one that wastes the developer's time.
 */
export function buildAnalysisPrompt(options: AnalysisPromptOptions): string {
  const evidence = [
    `- The workspace wiki at ${options.wikiDir} (read-only): the architecture of the existing systems. Read it thoroughly before writing any question.`,
  ];

  if (options.hasJira) {
    evidence.push(
      "- jira.md in your working directory: the Jira record — summary, description, comments, subtasks, links, attachment contents.",
    );
  }

  if (options.hasBrief) {
    evidence.push(
      "- brief.md in your working directory: the developer's own summary of the project.",
    );
  }

  const sections = options.template.sections
    .map(
      (section) =>
        `${section.number}. ${section.title} — ${section.instruction || "(no note)"}`,
    )
    .join("\n");

  const parts = [
    'You are OpenWiki, preparing a technical design interview. Do NOT write any document yet. Your only job is to find out what a developer must be asked before the company\'s "MVP - Teknik Detay" template can be filled for this project.',
    `Evidence available to you:\n${evidence.join("\n")}`,
    `The template's sections, each with its filling note:\n${sections}`,
    `Task: write questions.json in your working directory — a JSON array of objects shaped {"section": "<section number and title>", "question": "<the question>", "why": "<one short reason>"}. The file must contain only the JSON array.`,
    `Rules:
- NEVER ask what the wiki${options.hasJira ? ", jira.md," : ""}${options.hasBrief ? " or brief.md" : ""} already answers. Questions target only tacit knowledge the evidence cannot contain.
- Weight the questions toward the project's business flow: where it starts, its steps, error paths, and approvals.
- Also cover scope boundaries, technical choices the evidence cannot decide, and constraints — but only where a template section needs them.
- Write the questions in Turkish.
- At most 15 questions; fewer is better. Every question must earn its place.`,
  ];

  if (options.unreadableAttachments.length > 0) {
    parts.push(
      `The Jira record has attachments whose content could not be read: ${options.unreadableAttachments.join(", ")}. For each that looks relevant, add a question asking the developer to summarize its content.`,
    );
  }

  return parts.join("\n\n");
}

/** Inputs for the writing-pass prompt. */
export interface WritingPromptOptions {
  templateRaw: string;
  hasJira: boolean;
  hasBrief: boolean;
  wikiDir: string;
  /** Today, formatted DD/MM/YYYY for the template's Tarih field. */
  today: string;
}

/**
 * Builds the writing-pass prompt: fill the template from the evidence, under
 * the spec's hard rules — Kapsam Dışı for sections with no work, no
 * invention, unknowns stay marked, Açıklama notes never reach the output.
 */
export function buildWritingPrompt(options: WritingPromptOptions): string {
  const evidence = [
    `- The workspace wiki at ${options.wikiDir} (read-only): the architecture of the existing systems.`,
  ];

  if (options.hasJira) {
    evidence.push("- jira.md: the Jira record.");
  }

  if (options.hasBrief) {
    evidence.push("- brief.md: the developer's own summary.");
  }

  evidence.push(
    "- answers.md: the developer's interview answers. An answer of just `geç` means the question was skipped.",
  );

  return [
    'You are OpenWiki. Fill the company\'s "MVP - Teknik Detay" template for this project and write the finished document to tdd.md in your working directory.',
    `Evidence, in your working directory unless noted:\n${evidence.join("\n")}`,
    `The template to fill is between the TEMPLATE markers. Its "> Açıklama:" blockquotes are filling instructions addressed to you — follow them, but they must not appear in tdd.md (the template itself says to delete them).\n\n<TEMPLATE>\n${options.templateRaw}\n</TEMPLATE>`,
    `Rules:
- Write the document in Turkish. Keep code identifiers, file paths, endpoint names, and system names exactly as they appear in the evidence.
- Keep the numbered section headings exactly as in the template.
- A section with no work in this project gets exactly "Kapsam Dışı" as its body.
- Never invent an endpoint, table, saga, flow, screen, or system name. Every concrete claim must be grounded in the wiki, jira.md, brief.md, or answers.md.
- Anything the evidence does not settle stays as "[Netleştirilecek: <what is missing>]" — a marked gap beats a plausible guess.
- Header fields: derive "MVP Ad" from the evidence; "MVP Jira" is the issue key when one exists, otherwise "[Netleştirilecek: Jira kaydı]"; "Tarih" is ${options.today}; "Hazırlayan" is "[Netleştirilecek: hazırlayan]".
- Write nothing except tdd.md.`,
  ].join("\n\n");
}

/**
 * Validates and converts parsed entries to TddQuestion objects, shared by both
 * fenced and fallback parsing paths.
 */
function validateAndCapQuestions(parsed: unknown, raw: string): TddQuestion[] {
  if (!Array.isArray(parsed)) {
    throw new Error("The analysis pass's question list is not a JSON array.");
  }

  const questions: TddQuestion[] = [];

  for (const entry of parsed) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).section === "string" &&
      typeof (entry as Record<string, unknown>).question === "string"
    ) {
      const record = entry as Record<string, unknown>;
      questions.push({
        section: record.section as string,
        question: record.question as string,
        ...(typeof record.why === "string" ? { why: record.why } : {}),
      });
    }
  }

  if (questions.length === 0) {
    throw new Error(
      `The analysis pass produced no usable questions. Raw output:\n${raw.slice(0, 400)}`,
    );
  }

  return questions.slice(0, MAX_QUESTIONS);
}

/**
 * Parses the analysis pass's question list, tolerantly: model output may
 * fence the JSON, wrap it in prose, or include broken entries. Broken
 * entries are dropped; a reply with no usable questions throws, carrying an
 * excerpt of the raw output so the failure is debuggable.
 */
export function parseQuestions(raw: string): TddQuestion[] {
  // First, try to extract fenced code blocks
  const fenceRegex = /```[a-z]*\n?([\s\S]*?)```/giu;
  let match = fenceRegex.exec(raw);

  while (match !== null) {
    const blockContent = match[1].trim();
    if (blockContent.startsWith("[")) {
      try {
        const parsed = JSON.parse(blockContent) as unknown;
        return validateAndCapQuestions(parsed, raw);
      } catch {
        // This fenced block didn't work, try the next one or fall back
      }
    }
    match = fenceRegex.exec(raw);
  }

  // Fallback: strip all fences and look for first [ to last ]
  const stripped = raw.replace(/```[a-z]*\n?/giu, "");
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");

  if (start === -1 || end <= start) {
    throw new Error(
      `The analysis pass produced no question list. Raw output:\n${raw.slice(0, 400)}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    throw new Error(
      `The analysis pass's question list is not valid JSON. Raw output:\n${raw.slice(0, 400)}`,
    );
  }

  return validateAndCapQuestions(parsed, raw);
}
