import { appendFile, readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import type { TddQuestion } from "./questions.js";

/** The terminal, injectable so tests script the developer's side. */
export interface InterviewIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** Typing this (or nothing) skips a question. */
const SKIP_TOKEN = "geç";

/** The default terminal. */
function defaultIo(): InterviewIo {
  return { input: process.stdin, output: process.stdout };
}

/**
 * Sequential line reader over an InterviewIo.
 *
 * readline/promises' question() drops lines that arrive while no question is
 * pending and throws once the input has ended — exactly what happens when a
 * test drives the interview with a pre-ended PassThrough. This reader queues
 * every line as it arrives, so callers await lines strictly in order however
 * the input is paced; an ended input yields "" for every further read, which
 * the interview records as a skip.
 */
class LineReader {
  private readonly lines: string[] = [];
  private readonly waiters: ((line: string) => void)[] = [];
  private closed = false;
  private readonly readline: Interface;

  constructor(private readonly io: InterviewIo) {
    this.readline = createInterface({ input: io.input });
    this.readline.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    this.readline.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter("");
    });
    const handleError = () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter("");
      this.readline.close();
    };
    this.io.input.on("error", handleError);
    this.readline.on("error", handleError);
  }

  /** Writes the prompt and resolves with the next input line ("" after EOF). */
  async question(prompt: string): Promise<string> {
    this.io.output.write(prompt);
    const queued = this.lines.shift();
    if (queued !== undefined) return queued;
    if (this.closed) return "";
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.readline.close();
  }
}

/**
 * One reader per input stream, shared between the brief and the interview.
 * A second readline on the same pre-ended stream would find it drained — the
 * first reader has already queued its lines — so the queue must be shared.
 */
const readers = new WeakMap<object, LineReader>();

function readerFor(io: InterviewIo): LineReader {
  const key = io.input as object;
  let reader = readers.get(key);
  if (!reader) {
    reader = new LineReader(io);
    readers.set(key, reader);
  }
  return reader;
}

function closeReader(io: InterviewIo): void {
  const key = io.input as object;
  readers.get(key)?.close();
  readers.delete(key);
}

/**
 * Asks for the optional free-form brief: lines until an empty line, so a
 * pasted paragraph with newlines survives. An immediate empty line skips.
 */
export async function askBrief(
  io: InterviewIo = defaultIo(),
): Promise<string | undefined> {
  const reader = readerFor(io);

  try {
    io.output.write(
      "İsterseniz projeyi birkaç cümleyle anlatın (bitirmek için boş satır; hemen boş satır = geç):\n",
    );

    const lines: string[] = [];

    for (;;) {
      const line = await reader.question("> ");
      if (!line.trim()) break;
      lines.push(line);
    }

    const brief = lines.join("\n").trim();
    return brief || undefined;
  } finally {
    // The interview follows on the same stream; only a real terminal's
    // reader is safe to close here (the user types on demand, nothing is
    // buffered to lose).
    if (io.input === process.stdin) closeReader(io);
  }
}

/**
 * Runs the terminal interview.
 *
 * Every answer is appended to `answersFile` the moment it is given — an
 * interrupted session loses nothing (the spec's incremental-persistence
 * requirement). Questions already answered in the file are not asked again;
 * previously *skipped* questions are, because the developer may know now.
 */
export async function runInterview(
  questions: TddQuestion[],
  answersFile: string,
  io: InterviewIo = defaultIo(),
): Promise<{ answered: number; skipped: number }> {
  const existing = await readFile(answersFile, "utf8").catch(() => "");
  const answeredBefore = parseAnswersFile(existing);
  const pending = questions.filter(
    (question) => !answeredBefore.has(question.question),
  );

  try {
    if (pending.length === 0) return { answered: 0, skipped: 0 };

    const reader = readerFor(io);
    io.output.write(
      `\n${pending.length} soru var. Cevap bilmiyorsanız "${SKIP_TOKEN}" yazın (veya boş bırakın); soru dokümanda [Netleştirilecek] olarak işaretlenir.\n`,
    );

    let answered = 0;
    let skipped = 0;

    for (const [index, question] of pending.entries()) {
      io.output.write(
        `\n[${index + 1}/${pending.length}] (${question.section})\n${question.question}\n`,
      );
      if (question.why) io.output.write(`(${question.why})\n`);

      const answer = (await reader.question("> ")).trim();
      const isSkip = !answer || answer.toLocaleLowerCase("tr") === SKIP_TOKEN;

      await appendFile(
        answersFile,
        `## Soru: ${question.question}\n\n${isSkip ? SKIP_TOKEN : answer}\n\n`,
        "utf8",
      );

      if (isSkip) skipped += 1;
      else answered += 1;
    }

    return { answered, skipped };
  } finally {
    closeReader(io);
  }
}

/**
 * Parses an answers file into question → answer. Entries whose answer is the
 * skip token are dropped, so a resumed run asks them again.
 */
export function parseAnswersFile(content: string): Map<string, string> {
  const map = new Map<string, string>();

  for (const block of content.split(/^## Soru: /mu).slice(1)) {
    const newline = block.indexOf("\n");

    if (newline === -1) continue;

    const question = block.slice(0, newline).trim();
    const answer = block.slice(newline + 1).trim();

    if (question && answer && answer !== SKIP_TOKEN) {
      map.set(question, answer);
    }
  }

  return map;
}
