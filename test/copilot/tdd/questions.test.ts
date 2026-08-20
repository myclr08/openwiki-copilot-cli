import { describe, expect, test } from "vitest";
import {
  BUNDLED_TDD_TEMPLATE,
  parseTddTemplate,
} from "../../../src/copilot/tdd/template.ts";
import {
  buildAnalysisPrompt,
  buildWritingPrompt,
  parseQuestions,
} from "../../../src/copilot/tdd/questions.ts";

const template = parseTddTemplate(BUNDLED_TDD_TEMPLATE);

describe("buildAnalysisPrompt", () => {
  test("lists every template section with its instruction", () => {
    const prompt = buildAnalysisPrompt({
      template,
      hasJira: true,
      hasBrief: false,
      unreadableAttachments: [],
      wikiDir: "/ws/openwiki",
    });

    expect(prompt).toContain("1. MVP Temel Kapsamı");
    expect(prompt).toContain("9. Diyagram Çizimleri");
    expect(prompt).toContain("questions.json");
    // The governing rule.
    expect(prompt).toMatch(/never ask what the wiki/iu);
    // Questions must come out in Turkish.
    expect(prompt).toMatch(/turkish/iu);
  });

  test("mentions only the evidence files that exist", () => {
    const withBoth = buildAnalysisPrompt({
      template,
      hasJira: true,
      hasBrief: true,
      unreadableAttachments: [],
      wikiDir: "/ws/openwiki",
    });
    const withNeither = buildAnalysisPrompt({
      template,
      hasJira: false,
      hasBrief: false,
      unreadableAttachments: [],
      wikiDir: "/ws/openwiki",
    });

    expect(withBoth).toContain("jira.md");
    expect(withBoth).toContain("brief.md");
    expect(withNeither).not.toContain("jira.md");
    expect(withNeither).not.toContain("brief.md");
  });

  test("asks about unreadable attachments by name", () => {
    const prompt = buildAnalysisPrompt({
      template,
      hasJira: true,
      hasBrief: false,
      unreadableAttachments: ["odeme-akisi.png"],
      wikiDir: "/ws/openwiki",
    });

    expect(prompt).toContain("odeme-akisi.png");
  });
});

describe("buildWritingPrompt", () => {
  test("embeds the template and states the hard rules", () => {
    const prompt = buildWritingPrompt({
      templateRaw: BUNDLED_TDD_TEMPLATE,
      hasJira: true,
      hasBrief: true,
      wikiDir: "/ws/openwiki",
      today: "20/08/2026",
    });

    expect(prompt).toContain("## 4. Backend Tarafında Yapılacak Teknik İşler");
    expect(prompt).toContain("Kapsam Dışı");
    expect(prompt).toContain("[Netleştirilecek:");
    expect(prompt).toContain("tdd.md");
    expect(prompt).toContain("20/08/2026");
    // The Açıklama notes are instructions, not output.
    expect(prompt).toMatch(/must not appear/iu);
    // No invention.
    expect(prompt).toMatch(/never invent/iu);
  });
});

describe("parseQuestions", () => {
  test("parses a plain JSON array", () => {
    const questions = parseQuestions(
      '[{"section":"1. MVP Temel Kapsamı","question":"Hangi problem çözülüyor?","why":"Kapsam"}]',
    );

    expect(questions).toEqual([
      {
        section: "1. MVP Temel Kapsamı",
        question: "Hangi problem çözülüyor?",
        why: "Kapsam",
      },
    ]);
  });

  test("tolerates markdown fences and surrounding prose", () => {
    const raw =
      'İşte sorular:\n```json\n[{"section":"5","question":"Yeni akış var mı?"}]\n```\nBitti.';

    expect(parseQuestions(raw)).toHaveLength(1);
  });

  test("drops malformed entries but keeps valid ones", () => {
    const questions = parseQuestions(
      '[{"section":"1","question":"Soru?"},{"bozuk":true},{"section":2,"question":3}]',
    );

    expect(questions).toHaveLength(1);
  });

  test("caps the list at 25 questions", () => {
    const many = JSON.stringify(
      Array.from({ length: 40 }, (_unused, index) => ({
        section: "1",
        question: `Soru ${index}?`,
      })),
    );

    expect(parseQuestions(many)).toHaveLength(25);
  });

  test("throws with an excerpt when nothing parses", () => {
    expect(() => parseQuestions("model tamamen serbest metin döndü")).toThrow(
      /serbest metin/u,
    );
  });

  test("drops non-string why but keeps the question", () => {
    const questions = parseQuestions(
      '[{"section":"1","question":"Soru?","why":3}]',
    );

    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual({
      section: "1",
      question: "Soru?",
    });
  });

  test("survives a stray bracket in prose before the fenced JSON", () => {
    const raw =
      'Kaynak: [wiki](openwiki/index.md)\n```json\n[{"section":"1","question":"Soru?"}]\n```';

    expect(parseQuestions(raw)).toHaveLength(1);
  });
});
