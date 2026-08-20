import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  BUNDLED_TDD_TEMPLATE,
  loadTddTemplate,
  parseTddTemplate,
  validateTddDocument,
} from "../../../src/copilot/tdd/template.ts";

/** A document that fills every bundled section. */
function completeDocument(): string {
  const template = parseTddTemplate(BUNDLED_TDD_TEMPLATE);
  return [
    "# MVP - Teknik Detay",
    "",
    "**MVP Ad:** QR ile Ödeme",
    "",
    ...template.sections.map(
      (section) => `## ${section.number}. ${section.title}\n\nKapsam Dışı`,
    ),
  ].join("\n");
}

describe("parseTddTemplate", () => {
  test("finds the nine numbered sections of the bundled template", () => {
    const template = parseTddTemplate(BUNDLED_TDD_TEMPLATE);

    expect(template.sections).toHaveLength(9);
    expect(template.sections[0]).toMatchObject({
      number: 1,
      title: "MVP Temel Kapsamı",
    });
    expect(template.sections[8]?.title).toBe("Diyagram Çizimleri");
  });

  test("attaches each section's Açıklama note as its instruction", () => {
    const template = parseTddTemplate(BUNDLED_TDD_TEMPLATE);

    expect(template.sections[0]?.instruction).toContain("iş ihtiyacını");
    // Multi-line blockquotes collapse into one instruction string.
    expect(template.sections[3]?.instruction).toContain("SAGA");
  });

  test("rejects a template with no numbered sections", () => {
    expect(() => parseTddTemplate("# Sadece başlık\n\nMetin.")).toThrow(
      /no numbered/iu,
    );
  });
});

describe("loadTddTemplate", () => {
  test("defaults to the bundled template", async () => {
    const { raw, template } = await loadTddTemplate(null);

    expect(raw).toBe(BUNDLED_TDD_TEMPLATE);
    expect(template.sections).toHaveLength(9);
  });

  test("loads a custom template file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-template-"));
    const file = path.join(dir, "custom.md");
    await writeFile(
      file,
      "## 1. Özet\n> Açıklama: Kısa özet.\n\n## 2. Detay\n> Açıklama: Detay.\n",
      "utf8",
    );

    const { template } = await loadTddTemplate(file);

    expect(template.sections.map((section) => section.title)).toEqual([
      "Özet",
      "Detay",
    ]);
  });
});

describe("validateTddDocument", () => {
  const template = parseTddTemplate(BUNDLED_TDD_TEMPLATE);

  test("accepts a document that fills every section", () => {
    const { warnings, pendingClarifications } = validateTddDocument(
      template,
      completeDocument(),
    );

    expect(warnings).toEqual([]);
    expect(pendingClarifications).toBe(0);
  });

  test("warns about a missing section", () => {
    const document = completeDocument().replace(
      /## 6\. Veritabanı İşlemleri/u,
      "## Veritabanı",
    );

    const { warnings } = validateTddDocument(template, document);

    expect(warnings.some((warning) => warning.includes("6."))).toBe(true);
  });

  test("warns about leftover template placeholders", () => {
    const document = `${completeDocument()}\n- [Örn: PaymentApi]`;

    const { warnings } = validateTddDocument(template, document);

    expect(warnings.some((warning) => warning.includes("[Örn"))).toBe(true);
  });

  test("counts Netleştirilecek markers without warning about them", () => {
    const document = `${completeDocument()}\n[Netleştirilecek: onay adımı]`;

    const { warnings, pendingClarifications } = validateTddDocument(
      template,
      document,
    );

    expect(warnings).toEqual([]);
    expect(pendingClarifications).toBe(1);
  });
});
