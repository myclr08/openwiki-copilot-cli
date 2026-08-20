import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  askBrief,
  parseAnswersFile,
  runInterview,
} from "../../../src/copilot/tdd/interview.ts";

/** Scripted terminal: the given lines arrive as the developer's typing. */
function scriptedIo(lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.end(lines.map((line) => `${line}\n`).join(""));
  return { io: { input, output }, printed: () => String(output.read() ?? "") };
}

const QUESTIONS = [
  { section: "1", question: "Hangi problem çözülüyor?" },
  { section: "5", question: "Yeni ROTA akışı gerekiyor mu?" },
];

describe("askBrief", () => {
  test("collects lines until an empty line", async () => {
    const { io } = scriptedIo(["QR ödeme MVP'si.", "Limit kontrolü var.", ""]);

    expect(await askBrief(io)).toBe("QR ödeme MVP'si.\nLimit kontrolü var.");
  });

  test("an immediate empty line means skip", async () => {
    const { io } = scriptedIo([""]);

    expect(await askBrief(io)).toBeUndefined();
  });
});

describe("runInterview", () => {
  test("asks each question and persists every answer immediately", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-interview-"));
    const answersFile = path.join(dir, "answers.md");
    const { io } = scriptedIo(["Mobil QR ödeme.", "geç"]);

    const result = await runInterview(QUESTIONS, answersFile, io);

    expect(result).toEqual({ answered: 1, skipped: 1 });
    const content = await readFile(answersFile, "utf8");
    expect(content).toContain("## Soru: Hangi problem çözülüyor?");
    expect(content).toContain("Mobil QR ödeme.");
    expect(content).toContain("## Soru: Yeni ROTA akışı gerekiyor mu?");
    expect(content).toContain("geç");
  });

  test("an empty answer counts as a skip", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-interview-"));
    const { io } = scriptedIo(["", ""]);

    const result = await runInterview(
      QUESTIONS,
      path.join(dir, "answers.md"),
      io,
    );

    expect(result).toEqual({ answered: 0, skipped: 2 });
  });

  test("resumes: answered questions are not asked again, skipped ones are", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-interview-"));
    const answersFile = path.join(dir, "answers.md");
    await writeFile(
      answersFile,
      "## Soru: Hangi problem çözülüyor?\n\nMobil QR ödeme.\n\n## Soru: Yeni ROTA akışı gerekiyor mu?\n\ngeç\n\n",
      "utf8",
    );
    // Only the previously skipped question should come back.
    const { io } = scriptedIo(["Evet, onay adımıyla."]);

    const result = await runInterview(QUESTIONS, answersFile, io);

    expect(result).toEqual({ answered: 1, skipped: 0 });
    const content = await readFile(answersFile, "utf8");
    expect(content).toContain("Evet, onay adımıyla.");
  });
});

describe("parseAnswersFile", () => {
  test("maps questions to answers, dropping skipped entries", () => {
    const map = parseAnswersFile(
      "## Soru: A?\n\nCevap A.\n\n## Soru: B?\n\ngeç\n\n",
    );

    expect(map.get("A?")).toBe("Cevap A.");
    expect(map.has("B?")).toBe(false);
  });
});
