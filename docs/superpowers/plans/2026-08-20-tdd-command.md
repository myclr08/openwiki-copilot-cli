# `openwiki tdd` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `openwiki tdd <workspace> [--jira KEY]`, which fills the company's Turkish "MVP - Teknik Detay" template by combining the workspace wiki, an optional Jira record, and a terminal developer interview, driven by two headless Copilot CLI passes.

**Architecture:** A five-step orchestration in `src/copilot/tdd/` that reuses the existing Copilot backend unchanged (`ensureCopilotAvailable` launcher resolution, `runCopilot` process runner, `OpenWikiRunEvent` bridge). OpenWiki owns every interactive moment because Copilot runs with `--no-ask-user`: Jira evidence → optional brief → analysis pass (question JSON) → terminal interview with incremental persistence → writing pass + deterministic validation.

**Tech Stack:** TypeScript (Node >= 22, ESM), vitest, existing stub-copilot test harness, `node:readline/promises`, global `fetch`, new pure-JS deps `unpdf` (PDF text) and `fflate` (DOCX unzip).

**Spec:** `docs/superpowers/specs/2026-08-20-tdd-command-design.md`

## Global Constraints

- Node >= 22, ESM, strict TS. `pnpm` runs via `corepack pnpm …` (no global pnpm on this machine).
- Only two new dependencies: `unpdf` and `fflate`. Both pure JS, no network use, no native build.
- Jira auth is **Bearer PAT only**: env `OPENWIKI_JIRA_BASE_URL` + `OPENWIKI_JIRA_TOKEN`. No basic auth.
- Generated document prose is **Turkish**; code, comments, and error messages are English (repo convention).
- Copilot invocations reuse `runCopilot` exactly as-is — never spawn `copilot` directly in new code.
- Every task ends green on: `corepack pnpm run typecheck`, `corepack pnpm exec eslint .`, `corepack pnpm exec prettier --check .`, and its named vitest run.
- Commit messages follow repo style and end with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- All interactive I/O must accept injected streams (`InterviewIo`) so tests never touch the real TTY.

## File Map

| File                                                           | Responsibility                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/copilot/tdd/template.ts`                                  | Bundled template string, `--template` loading, section model, document validation                        |
| `src/copilot/tdd/extract.ts`                                   | Attachment text extraction: txt/md/csv, PDF (unpdf), DOCX (fflate)                                       |
| `src/copilot/tdd/jira.ts`                                      | Fetch issue + comments + subtasks + links + remote links + attachments over Bearer PAT; render `jira.md` |
| `src/copilot/tdd/questions.ts`                                 | Analysis-pass and writing-pass prompt builders; tolerant question-JSON parsing                           |
| `src/copilot/tdd/interview.ts`                                 | Brief prompt; terminal Q&A loop; incremental `answers.md`; resume parsing                                |
| `src/copilot/tdd/run.ts`                                       | Orchestration of the five steps; run directory; summary result                                           |
| `src/cli/tdd-command.ts`                                       | Argument parsing, mirroring `src/cli/workspace-command.ts`                                               |
| `src/cli/commands.ts`, `src/cli/cli.tsx`, `src/cli/runners.ts` | Dispatch, env loading, line-oriented runner, help                                                        |

Existing interfaces consumed (do not modify these files except where a task says so):

- `src/copilot/detect.ts`: `ensureCopilotAvailable(env?): Promise<{ launcher: CopilotLauncher; version: string }>`, `CopilotLauncher = { command: string; prefixArgs: string[] }`.
- `src/copilot/process.ts`: `runCopilot(invocation): Promise<{ exitCode, fatalError?, text, timedOut }>` where invocation accepts `{ cwd, prompt, addDirs?, launcher?, model?, env?, onEvent?, signal?, timeoutMs? }`.
- `src/copilot/config.ts`: `DEFAULT_WIKI_DIRECTORY = "openwiki"`, `DEFAULT_COPILOT_CLI_MODEL`, `COPILOT_CLI_BIN_ENV_KEY`.
- `src/agent/types.ts`: `OpenWikiRunEvent`.
- `test/copilot/stub-copilot.ts`: `createStubCopilot({ events?, files?, failFor?, exitCode?, stderr?, sleepMs? })` → `{ binary, invocations() }`. The stub answers `--version` and writes `files` (relative → cwd) on every non-version invocation.

---

### Task 1: Template module

**Files:**

- Create: `src/copilot/tdd/template.ts`
- Test: `test/copilot/tdd/template.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `interface TddTemplateSection { number: number; title: string; instruction: string }`
  - `interface TddTemplate { sections: TddTemplateSection[] }`
  - `const BUNDLED_TDD_TEMPLATE: string`
  - `parseTddTemplate(markdown: string): TddTemplate` (throws when no `## N. Title` section exists)
  - `loadTddTemplate(templatePath?: string | null): Promise<{ raw: string; template: TddTemplate }>`
  - `validateTddDocument(template: TddTemplate, document: string): { warnings: string[]; pendingClarifications: number }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/copilot/tdd/template.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm exec vitest run test/copilot/tdd/template.test.ts`
Expected: FAIL — module `src/copilot/tdd/template.ts` does not exist.

- [ ] **Step 3: Implement the module**

```ts
// src/copilot/tdd/template.ts
import { readFile } from "node:fs/promises";

/** One numbered section of the company TDD template. */
export interface TddTemplateSection {
  /** The section's number in the template, e.g. 4. */
  number: number;

  /** The heading text after the number, e.g. "Veritabanı İşlemleri". */
  title: string;

  /**
   * The section's `> Açıklama:` note — a filling instruction for the writing
   * pass. Never part of the generated document; the template itself says to
   * delete these notes.
   */
  instruction: string;
}

/** The section model a template parses into. */
export interface TddTemplate {
  sections: TddTemplateSection[];
}

/**
 * Markdown mirror of the company's "MVP - Teknik Detay" PDF template.
 *
 * The `> Açıklama:` blockquotes carry the PDF's filling notes; the writing
 * prompt forwards them as instructions and forbids them in the output.
 * `--template` substitutes any other file with the same `## N. Title` shape.
 */
export const BUNDLED_TDD_TEMPLATE = `# MVP - Teknik Detay

**MVP Ad:** [Doldurulacak]

**MVP Jira:** [Doldurulacak — Jira linki]

**Tarih:** [DD/MM/YYYY]

**Hazırlayan:** [İsim Soyisim]

## 1. MVP Temel Kapsamı

> Açıklama: Hangi problem çözülüyor veya hangi özellik kazandırılıyor? Çok
> detaya girmeden, iş ihtiyacını özetleyiniz.

## 2. Üzerinde Çalışılacak Uygulamalar

> Açıklama: Bu geliştirme hangi mikroservisleri, önyüz projelerini, batch
> job'ları veya harici entegrasyon noktalarını etkiliyor? Sadece isim listesi
> veya kısa bir bağımlılık özeti yeterlidir. Mikroservisler, Önyüz
> Uygulamaları ve Harici Sistemler olarak ayırınız.

## 3. Frontend Tarafında Yapılacak Teknik İşler

> Açıklama: Önyüz işi yoksa "Kapsam Dışı" yazıp geçiniz. Hangi ekranlar
> eklenecek veya mevcut ekranlarda ne değişecek? Yeni butonlar, validasyon
> kuralları veya state yönetimi gereksinimlerini maddeler halinde yazınız.

## 4. Backend Tarafında Yapılacak Teknik İşler

> Açıklama: Backend işi yoksa "Kapsam Dışı" yazıp geçiniz. İş mantığı nerede
> kurgulanacak, hangi servisler birbirini çağıracak? Validasyonlar,
> hesaplamalar veya entegrasyon mantıkları nelerdir? Yeni API uçları veya
> event-driven (SAGA/Kafka/RabbitMQ) yapıları nelerdir? Metot tipi (GET/POST)
> ve kısa açıklama yeterlidir; request/response şeması gerekmez. SAGA
> tanımında RequestSaga ya da EventSaga kullanımını belirtiniz.

## 5. ROTA Akış İşlemleri

> Açıklama: ROTA akışları ile ilgili çalışma yoksa "Kapsam Dışı" yazıp
> geçiniz. Yeni akış oluşturulacak mı? Mevcut akış üzerinde değişiklik var
> mı? Yeni Adım, Yeni Aksiyon ve Akış Datası düzenlemelerini belirtiniz.

## 6. Veritabanı İşlemleri

> Açıklama: Veritabanı değişikliği yoksa "Kapsam Dışı" yazıp geçiniz. Yeni
> tablo oluşturulacak mı? Mevcut tablolara yeni kolon eklenecek mi? Veri
> migrasyonu (update script) gerekecek mi? DWH veya Insight rapor çalışması
> olacak mı?

## 7. Tanımlar

> Açıklama: Bu özelliği canlıya alırken veya işletirken ihtiyaç duyulacak
> konfigürasyonlar nelerdir? Parametre, EOD tanımı, ELK index, monitoring,
> safe, yetki, network (Layer7 ya da 3rd party erişimler), notification ve
> feature flag kullanımını değerlendiriniz.

## 8. Onay İşlemleri

> Açıklama: Herhangi bir onay ihtiyacı yoksa "Kapsam Dışı" yazıp geçiniz.
> Genel onay veya harici onay yapısı olacaksa ana teknik tasarım dokümanına
> eklendi mi?

## 9. Diyagram Çizimleri

> Açıklama: Ana teknik tasarım dokümanındaki diyagramda MVP gösterimi yapılıp
> yapılmadığını belirtiniz. Transactional işlemler için Idempotency & Data
> Consistency sequence diyagram durumunu ve diyagramdaki sayfa bilgisini
> belirtiniz.
`;

/** Matches a numbered section heading: `## 4. Backend ...`. */
const SECTION_HEADING = /^## (\d+)\. (.+)$/u;

/**
 * Template placeholders that must not survive into a finished document.
 * `[Netleştirilecek: …]` is deliberately absent: it is the tool's own marker
 * for an open question, reported as a count, not a defect.
 */
const TEMPLATE_PLACEHOLDER =
  /\[(?:Örn|Buraya|Doldurulacak|İsim Soyisim|DD\/MM|Yapılacak iş|Adım ismi|Aksion ismi|Yapılan düzenlemeler)/u;

/** The tool's own open-question marker. */
const CLARIFICATION_MARKER = /\[Netleştirilecek:/gu;

/** Parses a template's numbered sections and their Açıklama instructions. */
export function parseTddTemplate(markdown: string): TddTemplate {
  const sections: TddTemplateSection[] = [];
  let current: TddTemplateSection | undefined;

  for (const line of markdown.split("\n")) {
    const heading = SECTION_HEADING.exec(line.trim());

    if (heading) {
      current = {
        number: Number(heading[1]),
        title: (heading[2] ?? "").trim(),
        instruction: "",
      };
      sections.push(current);
      continue;
    }

    if (current && line.trimStart().startsWith(">")) {
      const text = line.trimStart().replace(/^>\s?/u, "").trim();

      if (text) {
        current.instruction = current.instruction
          ? `${current.instruction} ${text}`
          : text;
      }
    }
  }

  if (sections.length === 0) {
    throw new Error(
      "The TDD template contains no numbered '## N. Title' sections; nothing to fill.",
    );
  }

  return { sections };
}

/** Loads the template to fill: `--template <file>`, or the bundled default. */
export async function loadTddTemplate(
  templatePath?: string | null,
): Promise<{ raw: string; template: TddTemplate }> {
  const raw = templatePath
    ? await readFile(templatePath, "utf8")
    : BUNDLED_TDD_TEMPLATE;

  return { raw, template: parseTddTemplate(raw) };
}

/**
 * Checks a finished document against the template it was filled from: every
 * numbered section present, no template placeholder left behind. Reports —
 * never rewrites. Whether the document is good enough to paste is the
 * developer's call, so problems come back as warnings, not errors.
 */
export function validateTddDocument(
  template: TddTemplate,
  document: string,
): { warnings: string[]; pendingClarifications: number } {
  const warnings: string[] = [];

  for (const section of template.sections) {
    const heading = new RegExp(`^#{2,3} ${section.number}\\. `, "mu");

    if (!heading.test(document)) {
      warnings.push(`Bölüm eksik: ${section.number}. ${section.title}`);
    }
  }

  for (const line of document.split("\n")) {
    if (TEMPLATE_PLACEHOLDER.test(line)) {
      warnings.push(`Doldurulmamış şablon alanı: ${line.trim().slice(0, 80)}`);
    }
  }

  return {
    warnings,
    pendingClarifications: document.match(CLARIFICATION_MARKER)?.length ?? 0,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `corepack pnpm exec vitest run test/copilot/tdd/template.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Lint, format, typecheck**

Run: `corepack pnpm run typecheck && corepack pnpm exec eslint . && corepack pnpm exec prettier --write src/copilot/tdd/ test/copilot/tdd/`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/copilot/tdd/template.ts test/copilot/tdd/template.test.ts
git commit -m "feat: TDD template model, bundled company template, validation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Attachment text extraction

**Files:**

- Create: `src/copilot/tdd/extract.ts`
- Modify: `package.json` (add `unpdf`, `fflate`)
- Test: `test/copilot/tdd/extract.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `extractAttachmentText(filename: string, data: Uint8Array): Promise<string | undefined>` — `undefined` means "unreadable format" (images, Excel, …).
  - `extractPdfText(data: Uint8Array): Promise<string>`
  - `extractDocxText(data: Uint8Array): string`

- [ ] **Step 1: Add the dependencies**

Run: `corepack pnpm add unpdf fflate`
Expected: both land in `dependencies`; lockfile updates; no build scripts run.

- [ ] **Step 2: Write the failing tests**

The DOCX fixture is built in-test with fflate (a .docx is a zip holding
`word/document.xml`). The PDF fixture is built by a helper that computes the
xref offsets, so the bytes are a valid PDF without a binary file in the repo.

```ts
// test/copilot/tdd/extract.test.ts
import { describe, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  extractAttachmentText,
  extractDocxText,
  extractPdfText,
} from "../../../src/copilot/tdd/extract.ts";

/** Builds a minimal but structurally valid single-page PDF containing `text`. */
function buildMinimalPdf(text: string): Uint8Array {
  const streamContent = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];

  objects.forEach((content, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });

  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new TextEncoder().encode(body);
}

/** Builds a minimal .docx: a zip with a word/document.xml. */
function buildMinimalDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((paragraph) => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`)
    .join("");

  return zipSync({
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
    ),
  });
}

describe("extractPdfText", () => {
  test("reads the text of a PDF", async () => {
    expect(await extractPdfText(buildMinimalPdf("Merhaba PDF"))).toContain(
      "Merhaba PDF",
    );
  });
});

describe("extractDocxText", () => {
  test("reads paragraphs and decodes XML entities", () => {
    const text = extractDocxText(
      buildMinimalDocx(["Ödeme akışı", "QR &amp; NFC"]),
    );

    expect(text).toContain("Ödeme akışı");
    expect(text).toContain("QR & NFC");
  });

  test("rejects an archive without word/document.xml", () => {
    const zip = zipSync({ "other.txt": strToU8("x") });

    expect(() => extractDocxText(zip)).toThrow(/word\/document\.xml/u);
  });
});

describe("extractAttachmentText", () => {
  test("passes plain-text formats through", async () => {
    const data = new TextEncoder().encode("kolon;deger");

    expect(await extractAttachmentText("veri.csv", data)).toBe("kolon;deger");
    expect(await extractAttachmentText("notlar.md", data)).toBe("kolon;deger");
  });

  test("routes by extension to the pdf and docx extractors", async () => {
    expect(
      await extractAttachmentText("akis.pdf", buildMinimalPdf("Akis")),
    ).toContain("Akis");
    expect(
      await extractAttachmentText("analiz.docx", buildMinimalDocx(["Analiz"])),
    ).toContain("Analiz");
  });

  test("returns undefined for unreadable formats", async () => {
    expect(
      await extractAttachmentText("ekran.png", new Uint8Array([1, 2, 3])),
    ).toBeUndefined();
    expect(
      await extractAttachmentText("tablo.xlsx", new Uint8Array([1, 2, 3])),
    ).toBeUndefined();
  });

  test("caps extracted text", async () => {
    const data = new TextEncoder().encode("a".repeat(50_000));

    const text = await extractAttachmentText("buyuk.txt", data);

    expect(text?.length).toBeLessThanOrEqual(20_010);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `corepack pnpm exec vitest run test/copilot/tdd/extract.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the module**

```ts
// src/copilot/tdd/extract.ts
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";

/** Formats included verbatim in the evidence. */
const TEXT_EXTENSIONS = new Set([".csv", ".md", ".txt"]);

/**
 * Per-attachment cap on extracted characters. Evidence feeds a prompt; an
 * unbounded spreadsheet export must not crowd out the wiki.
 */
const MAX_EXTRACT_CHARS = 20_000;

/**
 * Extracts readable text from a Jira attachment, routed by extension.
 *
 * Returns `undefined` for formats this backend cannot read (images, Excel,
 * Visio, …). The caller lists those by name and turns them into interview
 * questions instead of dropping them silently — see the spec's attachment
 * table.
 */
export async function extractAttachmentText(
  filename: string,
  data: Uint8Array,
): Promise<string | undefined> {
  const extension = path.extname(filename).toLowerCase();

  if (TEXT_EXTENSIONS.has(extension)) {
    return cap(new TextDecoder().decode(data));
  }

  if (extension === ".pdf") {
    return cap(await extractPdfText(data));
  }

  if (extension === ".docx") {
    return cap(extractDocxText(data));
  }

  return undefined;
}

/** Extracts a PDF's text with unpdf (pure-JS pdf.js build, no workers). */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });

  return text.trim();
}

/**
 * Extracts a .docx's text: unzip, read `word/document.xml`, break paragraphs
 * at `<w:p>` boundaries, strip the remaining tags, decode the XML entities.
 * Deliberately dependency-light — evidence needs the words, not the styling.
 */
export function extractDocxText(data: Uint8Array): string {
  const files = unzipSync(data);
  const document = files["word/document.xml"];

  if (!document) {
    throw new Error("Not a readable .docx: word/document.xml is missing.");
  }

  return strFromU8(document)
    .replace(/<w:p[ >]/gu, "\n<w:p ")
    .replace(/<[^>]+>/gu, "")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Applies the per-attachment cap with a marker the model can see. */
function cap(text: string): string {
  return text.length <= MAX_EXTRACT_CHARS
    ? text
    : `${text.slice(0, MAX_EXTRACT_CHARS)}\n[…kısaltıldı]`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `corepack pnpm exec vitest run test/copilot/tdd/extract.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Lint, format, typecheck, commit**

Run: `corepack pnpm run typecheck && corepack pnpm exec eslint . && corepack pnpm exec prettier --write src/copilot/tdd/ test/copilot/tdd/ package.json`

```bash
git add src/copilot/tdd/extract.ts test/copilot/tdd/extract.test.ts package.json pnpm-lock.yaml
git commit -m "feat: Jira attachment text extraction (txt/md/csv, pdf, docx)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Jira evidence

**Files:**

- Create: `src/copilot/tdd/jira.ts`
- Test: `test/copilot/tdd/jira.test.ts`

**Interfaces:**

- Consumes: `extractAttachmentText` from Task 2.
- Produces:
  - `const JIRA_BASE_URL_ENV_KEY = "OPENWIKI_JIRA_BASE_URL"`, `const JIRA_TOKEN_ENV_KEY = "OPENWIKI_JIRA_TOKEN"`
  - `interface JiraEvidence { key: string; markdown: string; unreadableAttachments: string[] }`
  - `fetchJiraEvidence(key: string, env?: NodeJS.ProcessEnv): Promise<JiraEvidence>` — throws before any Copilot run on missing env, HTTP error (message carries status + URL), or timeout.

- [ ] **Step 1: Write the failing tests**

The fake Jira is a `node:http` server started per test file; the base URL
env points at it. No mocking framework — the module's real `fetch` hits the
real localhost server.

```ts
// test/copilot/tdd/jira.test.ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  JIRA_BASE_URL_ENV_KEY,
  JIRA_TOKEN_ENV_KEY,
  fetchJiraEvidence,
} from "../../../src/copilot/tdd/jira.ts";

let server: Server;
let baseUrl: string;
let lastAuthHeader: string | undefined;

/** The canned issue the fake Jira serves. */
const ISSUE = {
  key: "DNZ-1111",
  fields: {
    summary: "QR ile Ödeme Entegrasyonu",
    description:
      "Müşteri QR okutarak ödeme yapabilmeli.\nKabul: limit kontrolü.",
    status: { name: "In Progress" },
    issuetype: { name: "Story" },
    labels: ["mvp"],
    comment: {
      comments: [
        {
          author: { displayName: "Ayşe Yılmaz" },
          created: "2026-08-01T10:00:00.000+0300",
          body: "EOD mutabakatına dahil edilecek.",
        },
      ],
    },
    attachment: [
      {
        filename: "analiz.txt",
        size: 12,
        mimeType: "text/plain",
        content: "", // set once the server URL is known
      },
      {
        filename: "akis-diyagrami.png",
        size: 34,
        mimeType: "image/png",
        content: "",
      },
    ],
    issuelinks: [
      {
        type: { name: "Relates" },
        outwardIssue: { key: "DNZ-900", fields: { summary: "Limit servisi" } },
      },
    ],
    subtasks: [
      {
        key: "DNZ-1112",
        fields: { summary: "QR üretimi", status: { name: "To Do" } },
      },
    ],
  },
};

beforeAll(async () => {
  server = createServer((request, response) => {
    lastAuthHeader = request.headers.authorization;

    if (request.url?.startsWith("/rest/api/2/issue/DNZ-1111/remotelink")) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify([
          { object: { title: "Analiz Sayfası", url: "https://conf/x" } },
        ]),
      );
      return;
    }

    if (request.url?.startsWith("/rest/api/2/issue/DNZ-1111")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(ISSUE));
      return;
    }

    if (request.url === "/attachment/analiz.txt") {
      response.end("QR analizi ok");
      return;
    }

    if (request.url === "/attachment/akis-diyagrami.png") {
      response.end(Buffer.from([137, 80, 78, 71]));
      return;
    }

    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ISSUE.fields.attachment[0]!.content = `${baseUrl}/attachment/analiz.txt`;
  ISSUE.fields.attachment[1]!.content = `${baseUrl}/attachment/akis-diyagrami.png`;
});

afterAll(() => {
  server.close();
});

/** Env pointing the module at the fake Jira. */
function jiraEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [JIRA_BASE_URL_ENV_KEY]: baseUrl,
    [JIRA_TOKEN_ENV_KEY]: "pat-123",
  };
}

describe("fetchJiraEvidence", () => {
  test("renders the record into one evidence file", async () => {
    const evidence = await fetchJiraEvidence("DNZ-1111", jiraEnv());

    expect(evidence.key).toBe("DNZ-1111");
    expect(evidence.markdown).toContain("QR ile Ödeme Entegrasyonu");
    expect(evidence.markdown).toContain("limit kontrolü");
    expect(evidence.markdown).toContain("Ayşe Yılmaz");
    expect(evidence.markdown).toContain("DNZ-1112");
    expect(evidence.markdown).toContain("DNZ-900");
    expect(evidence.markdown).toContain("Analiz Sayfası");
  });

  test("authenticates with the Bearer PAT", async () => {
    await fetchJiraEvidence("DNZ-1111", jiraEnv());

    expect(lastAuthHeader).toBe("Bearer pat-123");
  });

  test("includes readable attachment content and lists unreadable ones", async () => {
    const evidence = await fetchJiraEvidence("DNZ-1111", jiraEnv());

    expect(evidence.markdown).toContain("QR analizi ok");
    expect(evidence.markdown).toContain("akis-diyagrami.png");
    expect(evidence.unreadableAttachments).toEqual(["akis-diyagrami.png"]);
  });

  test("fails without the env vars, naming both", async () => {
    await expect(
      fetchJiraEvidence("DNZ-1111", {
        ...process.env,
        [JIRA_BASE_URL_ENV_KEY]: "",
        [JIRA_TOKEN_ENV_KEY]: "",
      }),
    ).rejects.toThrow(/OPENWIKI_JIRA_BASE_URL.*OPENWIKI_JIRA_TOKEN/su);
  });

  test("fails on an unknown issue with status and URL", async () => {
    await expect(fetchJiraEvidence("DNZ-404", jiraEnv())).rejects.toThrow(
      /HTTP 404.*DNZ-404/su,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm exec vitest run test/copilot/tdd/jira.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

```ts
// src/copilot/tdd/jira.ts
import { extractAttachmentText } from "./extract.js";

export const JIRA_BASE_URL_ENV_KEY = "OPENWIKI_JIRA_BASE_URL";
export const JIRA_TOKEN_ENV_KEY = "OPENWIKI_JIRA_TOKEN";

/** Attachments above this size are listed but never downloaded. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** One HTTP round trip's budget. */
const FETCH_TIMEOUT_MS = 30_000;

/** The Jira evidence for one run. */
export interface JiraEvidence {
  key: string;

  /** The whole record rendered as one Markdown evidence file. */
  markdown: string;

  /**
   * Filenames of attachments whose content could not be read (images, Excel,
   * …). The analysis pass turns these into interview questions.
   */
  unreadableAttachments: string[];
}

/**
 * Fetches a Jira issue and renders it into one evidence file: summary,
 * description (acceptance criteria normally live inside it on Server/DC),
 * comments, subtasks, issue links, remote links, and attachment contents
 * where a format allows extraction.
 *
 * Auth is a profile Personal Access Token sent as a Bearer header — the
 * Server/DC convention, per the spec. Every failure here happens before any
 * Copilot run starts, so the message carries the exact status and URL.
 */
export async function fetchJiraEvidence(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JiraEvidence> {
  const baseUrl = env[JIRA_BASE_URL_ENV_KEY]?.trim().replace(/\/+$/u, "");
  const token = env[JIRA_TOKEN_ENV_KEY]?.trim();

  if (!baseUrl || !token) {
    throw new Error(
      `Jira access needs ${JIRA_BASE_URL_ENV_KEY} and ${JIRA_TOKEN_ENV_KEY} ` +
        "(a profile Personal Access Token). Set them in the shell or in ~/.openwiki/.env.",
    );
  }

  const issueUrl =
    `${baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}` +
    "?fields=summary,description,status,issuetype,labels,comment,attachment,issuelinks,subtasks";
  const issue = (await jiraGet(issueUrl, token)) as JiraIssue;

  // Remote links carry the Confluence pages; a Jira without the endpoint
  // (or without permission) degrades to an empty list, not a failed run.
  const remoteLinks = (await jiraGet(
    `${baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}/remotelink`,
    token,
  ).catch(() => [])) as RemoteLink[];

  const attachments: RenderedAttachment[] = [];

  for (const attachment of issue.fields.attachment ?? []) {
    attachments.push(await readAttachment(attachment, token));
  }

  return {
    key: issue.key ?? key,
    markdown: renderMarkdown(
      issue.key ?? key,
      issue.fields,
      remoteLinks,
      attachments,
    ),
    unreadableAttachments: attachments
      .filter(
        (attachment) => attachment.text === undefined && !attachment.skipped,
      )
      .map((attachment) => attachment.filename),
  };
}

/* ---------- wire types (the fields this module actually reads) ---------- */

interface JiraIssue {
  key?: string;
  fields: JiraFields;
}

interface JiraFields {
  summary?: string;
  description?: string | null;
  status?: { name?: string };
  issuetype?: { name?: string };
  labels?: string[];
  comment?: { comments?: JiraComment[] };
  attachment?: JiraAttachment[];
  issuelinks?: JiraIssueLink[];
  subtasks?: JiraSubtask[];
}

interface JiraComment {
  author?: { displayName?: string };
  created?: string;
  body?: string;
}

interface JiraAttachment {
  filename?: string;
  size?: number;
  mimeType?: string;
  content?: string;
}

interface JiraIssueLink {
  type?: { name?: string };
  outwardIssue?: { key?: string; fields?: { summary?: string } };
  inwardIssue?: { key?: string; fields?: { summary?: string } };
}

interface JiraSubtask {
  key?: string;
  fields?: { summary?: string; status?: { name?: string } };
}

interface RemoteLink {
  object?: { title?: string; url?: string };
}

interface RenderedAttachment {
  filename: string;
  size: number;
  mimeType: string;
  /** Extracted content; undefined when the format is unreadable. */
  text?: string;
  /** True when the download was skipped (too large, or fetch failed). */
  skipped: boolean;
}

/* ------------------------------ internals ------------------------------ */

/** One authenticated GET, JSON-decoded, with status+URL on failure. */
async function jiraGet(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Jira request failed with HTTP ${response.status}: ${url}`);
  }

  return response.json();
}

/** Downloads one attachment and extracts its text where the format allows. */
async function readAttachment(
  attachment: JiraAttachment,
  token: string,
): Promise<RenderedAttachment> {
  const rendered: RenderedAttachment = {
    filename: attachment.filename ?? "adsiz",
    size: attachment.size ?? 0,
    mimeType: attachment.mimeType ?? "unknown",
    skipped: false,
  };

  if (!attachment.content || rendered.size > MAX_ATTACHMENT_BYTES) {
    rendered.skipped = true;
    return rendered;
  }

  try {
    const response = await fetch(attachment.content, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      rendered.skipped = true;
      return rendered;
    }

    const data = new Uint8Array(await response.arrayBuffer());
    rendered.text = await extractAttachmentText(rendered.filename, data);
  } catch {
    // A single broken attachment must not fail the whole evidence fetch.
    rendered.skipped = true;
  }

  return rendered;
}

/** Renders the record into the jira.md evidence file. */
function renderMarkdown(
  key: string,
  fields: JiraFields,
  remoteLinks: RemoteLink[],
  attachments: RenderedAttachment[],
): string {
  const lines: string[] = [
    `# ${key} — ${fields.summary ?? ""}`.trim(),
    "",
    `Durum: ${fields.status?.name ?? "?"} · Tip: ${fields.issuetype?.name ?? "?"}` +
      (fields.labels?.length
        ? ` · Etiketler: ${fields.labels.join(", ")}`
        : ""),
    "",
    "## Açıklama",
    "",
    fields.description?.trim() || "(boş)",
  ];

  const subtasks = fields.subtasks ?? [];
  if (subtasks.length > 0) {
    lines.push("", "## Alt görevler", "");
    for (const subtask of subtasks) {
      lines.push(
        `- ${subtask.key ?? "?"} — ${subtask.fields?.summary ?? ""} (${subtask.fields?.status?.name ?? "?"})`,
      );
    }
  }

  const links = fields.issuelinks ?? [];
  if (links.length > 0) {
    lines.push("", "## Bağlı işler", "");
    for (const link of links) {
      const other = link.outwardIssue ?? link.inwardIssue;
      lines.push(
        `- ${link.type?.name ?? "İlişki"}: ${other?.key ?? "?"} — ${other?.fields?.summary ?? ""}`,
      );
    }
  }

  const comments = fields.comment?.comments ?? [];
  if (comments.length > 0) {
    lines.push("", "## Yorumlar", "");
    for (const comment of comments) {
      lines.push(
        `**${comment.author?.displayName ?? "?"}** (${comment.created ?? "?"}):`,
        "",
        comment.body ?? "",
        "",
      );
    }
  }

  if (remoteLinks.length > 0) {
    lines.push("", "## Uzak bağlantılar (v1'de içerikleri çekilmez)", "");
    for (const link of remoteLinks) {
      lines.push(`- ${link.object?.title ?? "?"} — ${link.object?.url ?? ""}`);
    }
  }

  if (attachments.length > 0) {
    lines.push("", "## Ekler", "");
    for (const attachment of attachments) {
      const state = attachment.skipped
        ? "indirilemedi/atlandı"
        : attachment.text !== undefined
          ? "içerik aşağıda"
          : "okunamayan format";
      lines.push(
        `- ${attachment.filename} (${attachment.mimeType}, ${attachment.size} bayt) — ${state}`,
      );
    }

    for (const attachment of attachments) {
      if (attachment.text !== undefined) {
        lines.push(
          "",
          `### Ek içeriği: ${attachment.filename}`,
          "",
          attachment.text,
        );
      }
    }
  }

  return `${lines.join("\n").trim()}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `corepack pnpm exec vitest run test/copilot/tdd/jira.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint, format, typecheck, commit**

Run: `corepack pnpm run typecheck && corepack pnpm exec eslint . && corepack pnpm exec prettier --write src/copilot/tdd/ test/copilot/tdd/`

```bash
git add src/copilot/tdd/jira.ts test/copilot/tdd/jira.test.ts
git commit -m "feat: Jira evidence fetch over Bearer PAT with attachment extraction

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Prompts and question parsing

**Files:**

- Create: `src/copilot/tdd/questions.ts`
- Test: `test/copilot/tdd/questions.test.ts`

**Interfaces:**

- Consumes: `TddTemplate`, `TddTemplateSection` from Task 1.
- Produces:
  - `interface TddQuestion { section: string; question: string; why?: string }`
  - `buildAnalysisPrompt(options: { template: TddTemplate; hasJira: boolean; hasBrief: boolean; unreadableAttachments: string[]; wikiDir: string }): string`
  - `buildWritingPrompt(options: { templateRaw: string; hasJira: boolean; hasBrief: boolean; wikiDir: string; today: string }): string`
  - `parseQuestions(raw: string): TddQuestion[]` — tolerant; throws with a raw-output excerpt when nothing parses.

- [ ] **Step 1: Write the failing tests**

````ts
// test/copilot/tdd/questions.test.ts
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
});
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm exec vitest run test/copilot/tdd/questions.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

````ts
// src/copilot/tdd/questions.ts
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
 * Parses the analysis pass's question list, tolerantly: model output may
 * fence the JSON, wrap it in prose, or include broken entries. Broken
 * entries are dropped; a reply with no usable questions throws, carrying an
 * excerpt of the raw output so the failure is debuggable.
 */
export function parseQuestions(raw: string): TddQuestion[] {
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
````

- [ ] **Step 4: Run tests, lint, commit**

Run: `corepack pnpm exec vitest run test/copilot/tdd/questions.test.ts` → PASS (9 tests).
Run: `corepack pnpm run typecheck && corepack pnpm exec eslint . && corepack pnpm exec prettier --write src/copilot/tdd/ test/copilot/tdd/`

```bash
git add src/copilot/tdd/questions.ts test/copilot/tdd/questions.test.ts
git commit -m "feat: TDD analysis/writing prompts and tolerant question parsing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Interview

**Files:**

- Create: `src/copilot/tdd/interview.ts`
- Test: `test/copilot/tdd/interview.test.ts`

**Interfaces:**

- Consumes: `TddQuestion` from Task 4.
- Produces:
  - `interface InterviewIo { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }`
  - `askBrief(io?: InterviewIo): Promise<string | undefined>` — reads lines until an empty line; an immediate empty line skips.
  - `runInterview(questions: TddQuestion[], answersFile: string, io?: InterviewIo): Promise<{ answered: number; skipped: number }>` — appends to `answersFile` after **every** answer; skips questions already answered there.
  - `parseAnswersFile(content: string): Map<string, string>` — question → answer; entries whose answer is `geç` are dropped so they are re-asked.

- [ ] **Step 1: Write the failing tests**

```ts
// test/copilot/tdd/interview.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm exec vitest run test/copilot/tdd/interview.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

```ts
// src/copilot/tdd/interview.ts
import { appendFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
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
 * Asks for the optional free-form brief: lines until an empty line, so a
 * pasted paragraph with newlines survives. An immediate empty line skips.
 */
export async function askBrief(
  io: InterviewIo = defaultIo(),
): Promise<string | undefined> {
  const readline = createInterface({ input: io.input, output: io.output });

  try {
    io.output.write(
      "İsterseniz projeyi birkaç cümleyle anlatın (bitirmek için boş satır; hemen boş satır = geç):\n",
    );

    const lines: string[] = [];

    for (;;) {
      const line = await readline.question("> ");

      if (!line.trim()) break;

      lines.push(line);
    }

    const brief = lines.join("\n").trim();

    return brief || undefined;
  } finally {
    readline.close();
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

  if (pending.length === 0) return { answered: 0, skipped: 0 };

  const readline = createInterface({ input: io.input, output: io.output });
  let answered = 0;
  let skipped = 0;

  try {
    io.output.write(
      `\n${pending.length} soru var. Cevap bilmiyorsanız "${SKIP_TOKEN}" yazın (veya boş bırakın); soru dokümanda [Netleştirilecek] olarak işaretlenir.\n`,
    );

    for (const [index, question] of pending.entries()) {
      io.output.write(
        `\n[${index + 1}/${pending.length}] (${question.section})\n${question.question}\n`,
      );

      if (question.why) {
        io.output.write(`(${question.why})\n`);
      }

      const answer = (await readline.question("> ")).trim();
      const isSkip = !answer || answer.toLocaleLowerCase("tr") === SKIP_TOKEN;

      await appendFile(
        answersFile,
        `## Soru: ${question.question}\n\n${isSkip ? SKIP_TOKEN : answer}\n\n`,
        "utf8",
      );

      if (isSkip) skipped += 1;
      else answered += 1;
    }
  } finally {
    readline.close();
  }

  return { answered, skipped };
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
```

- [ ] **Step 4: Run tests, lint, commit**

Run: `corepack pnpm exec vitest run test/copilot/tdd/interview.test.ts` → PASS (6 tests).
Run: `corepack pnpm run typecheck && corepack pnpm exec eslint . && corepack pnpm exec prettier --write src/copilot/tdd/ test/copilot/tdd/`

```bash
git add src/copilot/tdd/interview.ts test/copilot/tdd/interview.test.ts
git commit -m "feat: TDD terminal interview with incremental persistence and resume

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Orchestration

**Files:**

- Create: `src/copilot/tdd/run.ts`
- Test: `test/copilot/tdd/run.test.ts`

**Interfaces:**

- Consumes: everything above, plus `ensureCopilotAvailable`, `runCopilot`, `DEFAULT_WIKI_DIRECTORY`, `DEFAULT_COPILOT_CLI_MODEL`, `OpenWikiRunEvent`, and `createStubCopilot` in tests.
- Produces:
  - `interface TddRunOptions { workspaceRoot: string; jiraKey?: string | null; templatePath?: string | null; modelId?: string | null; outputFile?: string | null; onEvent?: (event: OpenWikiRunEvent) => void; io?: InterviewIo; env?: NodeJS.ProcessEnv }`
  - `interface TddRunResult { documentPath: string; runDir: string; warnings: string[]; pendingClarifications: number }`
  - `runTdd(options: TddRunOptions): Promise<TddRunResult>`

- [ ] **Step 1: Write the failing tests**

The stub Copilot writes `questions.json` and `tdd.md` on every invocation
(the analysis pass "produces" the questions; the writing pass "rewrites" the
same tdd.md — harmless and deterministic). The interview is scripted through
`InterviewIo` PassThrough streams: first an empty line (skip the brief),
then one answer per question.

```ts
// test/copilot/tdd/run.test.ts
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { COPILOT_CLI_BIN_ENV_KEY } from "../../../src/copilot/config.ts";
import {
  BUNDLED_TDD_TEMPLATE,
  parseTddTemplate,
} from "../../../src/copilot/tdd/template.ts";
import { runTdd } from "../../../src/copilot/tdd/run.ts";
import { assistantMessage, createStubCopilot } from "../stub-copilot.ts";

const QUESTIONS_JSON = JSON.stringify([
  { section: "1. MVP Temel Kapsamı", question: "Hangi problem çözülüyor?" },
]);

/** A tdd.md that satisfies validation for the bundled template. */
const VALID_TDD = [
  "# MVP - Teknik Detay",
  "",
  "**MVP Ad:** QR ile Ödeme",
  "",
  ...parseTddTemplate(BUNDLED_TDD_TEMPLATE).sections.map(
    (section) => `## ${section.number}. ${section.title}\n\nKapsam Dışı`,
  ),
].join("\n");

/** Creates a workspace with a minimal wiki. */
async function createWorkspaceWithWiki(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-tdd-run-"));
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "index.md"),
    "# Wiki\n\n- payment-api\n",
    "utf8",
  );
  return root;
}

/** Scripted developer: skip the brief, answer every question. */
function scriptedIo(answers: string[]) {
  const input = new PassThrough();
  input.end(["", ...answers].map((line) => `${line}\n`).join(""));
  return { input, output: new PassThrough() };
}

let previousBinary: string | undefined;

beforeEach(() => {
  previousBinary = process.env[COPILOT_CLI_BIN_ENV_KEY];
});

afterEach(() => {
  if (previousBinary === undefined) delete process.env[COPILOT_CLI_BIN_ENV_KEY];
  else process.env[COPILOT_CLI_BIN_ENV_KEY] = previousBinary;
});

async function useStub(files: Record<string, string>) {
  const stub = await createStubCopilot({
    events: [assistantMessage("Tamam.")],
    files,
  });
  process.env[COPILOT_CLI_BIN_ENV_KEY] = stub.binary;
  return stub;
}

describe("runTdd", () => {
  test("produces the document through analysis, interview, and writing", async () => {
    const root = await createWorkspaceWithWiki();
    const stub = await useStub({
      "questions.json": QUESTIONS_JSON,
      "tdd.md": VALID_TDD,
    });

    const result = await runTdd({
      workspaceRoot: root,
      io: scriptedIo(["Mobil QR ödeme."]),
    });

    expect(result.warnings).toEqual([]);
    expect(await readFile(result.documentPath, "utf8")).toContain(
      "MVP - Teknik Detay",
    );
    // Two Copilot invocations: analysis, then writing.
    expect(await stub.invocations()).toHaveLength(2);
    // The interview answer reached the evidence.
    expect(
      await readFile(path.join(result.runDir, "answers.md"), "utf8"),
    ).toContain("Mobil QR ödeme.");
  });

  test("names the run directory adhoc-<date> without a Jira key", async () => {
    const root = await createWorkspaceWithWiki();
    await useStub({ "questions.json": QUESTIONS_JSON, "tdd.md": VALID_TDD });

    const result = await runTdd({
      workspaceRoot: root,
      io: scriptedIo(["Cevap."]),
    });

    expect(path.basename(result.runDir)).toMatch(/^adhoc-\d{4}-\d{2}-\d{2}$/u);
  });

  test("grants the wiki as a read directory to both passes", async () => {
    const root = await createWorkspaceWithWiki();
    const stub = await useStub({
      "questions.json": QUESTIONS_JSON,
      "tdd.md": VALID_TDD,
    });

    await runTdd({ workspaceRoot: root, io: scriptedIo(["Cevap."]) });

    for (const invocation of await stub.invocations()) {
      expect(invocation.args).toContain(path.join(root, "openwiki"));
      expect(invocation.cwd).toContain(path.join(root, "tdd"));
    }
  });

  test("refuses a workspace without a wiki", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-tdd-nowiki-"));
    await useStub({});

    await expect(
      runTdd({ workspaceRoot: root, io: scriptedIo([]) }),
    ).rejects.toThrow(/openwiki workspace/u);
  });

  test("resumes: existing questions.json skips the analysis pass", async () => {
    const root = await createWorkspaceWithWiki();
    const stub = await useStub({ "tdd.md": VALID_TDD });
    const runDir = path.join(
      root,
      "tdd",
      `adhoc-${new Date().toISOString().slice(0, 10)}`,
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "questions.json"),
      QUESTIONS_JSON,
      "utf8",
    );
    await writeFile(path.join(runDir, "brief.md"), "Var olan brief.\n", "utf8");

    await runTdd({ workspaceRoot: root, io: scriptedIo(["Cevap."]) });

    // Only the writing pass ran; brief was not re-asked (no leading "" line
    // consumed: the scripted io's first line answered the interview).
    expect(await stub.invocations()).toHaveLength(1);
  });

  test("reports validation warnings without failing the run", async () => {
    const root = await createWorkspaceWithWiki();
    await useStub({
      "questions.json": QUESTIONS_JSON,
      "tdd.md": "# Eksik doküman\n\n## 1. MVP Temel Kapsamı\n\n[Örn: doldur]",
    });

    const result = await runTdd({
      workspaceRoot: root,
      io: scriptedIo(["Cevap."]),
    });

    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("fails clearly when the writing pass produces no tdd.md", async () => {
    const root = await createWorkspaceWithWiki();
    await useStub({ "questions.json": QUESTIONS_JSON });

    await expect(
      runTdd({ workspaceRoot: root, io: scriptedIo(["Cevap."]) }),
    ).rejects.toThrow(/tdd\.md/u);
  });

  test("copies the document to --output when given", async () => {
    const root = await createWorkspaceWithWiki();
    await useStub({ "questions.json": QUESTIONS_JSON, "tdd.md": VALID_TDD });
    const outputFile = path.join(root, "cikti", "dokuman.md");

    const result = await runTdd({
      workspaceRoot: root,
      outputFile,
      io: scriptedIo(["Cevap."]),
    });

    expect(result.documentPath).toBe(outputFile);
    expect(await readFile(outputFile, "utf8")).toContain("MVP - Teknik Detay");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm exec vitest run test/copilot/tdd/run.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

```ts
// src/copilot/tdd/run.ts
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
  const runName = jiraKey ?? `adhoc-${new Date().toISOString().slice(0, 10)}`;
  const runDir = path.join(workspaceRoot, "tdd", runName);
  await mkdir(runDir, { recursive: true });

  const emit = (text: string) => options.onEvent?.({ type: "text", text });

  // 1. Jira evidence. Always refetched when a key is given: fresh evidence
  // beats a stale copy, and the fetch is cheap next to a Copilot pass.
  let unreadableAttachments: string[] = [];

  if (jiraKey) {
    emit(`Jira ${jiraKey} okunuyor…`);
    const evidence = await fetchJiraEvidence(jiraKey, env);
    await writeFile(path.join(runDir, "jira.md"), evidence.markdown, "utf8");
    unreadableAttachments = evidence.unreadableAttachments;

    if (unreadableAttachments.length > 0) {
      emit(
        `Okunamayan ekler (mülakatta sorulacak): ${unreadableAttachments.join(", ")}`,
      );
    }
  }

  // 2. Brief — asked once; an existing brief.md (a resumed run) is kept.
  const briefFile = path.join(runDir, "brief.md");

  if (!(await exists(briefFile))) {
    const brief = await askBrief(options.io);

    if (brief) {
      await writeFile(briefFile, `${brief}\n`, "utf8");
    }
  }

  const hasJira = await exists(path.join(runDir, "jira.md"));
  const hasBrief = await exists(briefFile);

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

/** Whether a path exists. */
async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined)) !== undefined;
}
```

- [ ] **Step 4: Run tests, lint, commit**

Run: `corepack pnpm exec vitest run test/copilot/tdd/run.test.ts` → PASS (8 tests).
Run: `corepack pnpm run typecheck && corepack pnpm exec eslint . && corepack pnpm exec prettier --write src/copilot/tdd/ test/copilot/tdd/`

```bash
git add src/copilot/tdd/run.ts test/copilot/tdd/run.test.ts
git commit -m "feat: TDD run orchestration — jira, brief, analysis, interview, writing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: CLI wiring

**Files:**

- Create: `src/cli/tdd-command.ts`
- Modify: `src/cli/commands.ts` (import + union member + dispatch + help), `src/cli/cli.tsx` (env-load list + dispatch), `src/cli/runners.ts` (runner)
- Test: `test/cli/tdd-command.test.ts`

**Interfaces:**

- Consumes: `runTdd`, `TddRunResult` from Task 6; `getErrorMessage` from `src/platform/diagnostics.ts` (already imported in runners.ts).
- Produces:
  - `interface TddCliCommand { kind: "tdd"; exitCode: 0; workspaceRoot: string; jiraKey: string | null; templatePath: string | null; modelId: string | null; outputFile: string | null }`
  - `parseTddCommand(args: string[]): TddCliCommand | { kind: "error"; exitCode: 1; message: string }`
  - `runTddCommand(command: TddCliCommand): Promise<void>` in runners.ts

- [ ] **Step 1: Write the failing tests**

```ts
// test/cli/tdd-command.test.ts
import { describe, expect, test } from "vitest";
import { parseCommand } from "../../src/cli/commands.ts";
import { parseTddCommand } from "../../src/cli/tdd-command.ts";

describe("parseTddCommand", () => {
  test("requires a workspace folder", () => {
    expect(parseTddCommand([])).toMatchObject({ kind: "error", exitCode: 1 });
  });

  test("parses the folder with defaults", () => {
    expect(parseTddCommand(["~/repos"])).toEqual({
      kind: "tdd",
      exitCode: 0,
      workspaceRoot: "~/repos",
      jiraKey: null,
      templatePath: null,
      modelId: null,
      outputFile: null,
    });
  });

  test("reads all options, space and inline forms", () => {
    expect(
      parseTddCommand([
        "~/repos",
        "--jira",
        "DNZ-1111",
        "--template=custom.md",
        "--model",
        "claude-sonnet-4.6",
        "--output=out.md",
      ]),
    ).toMatchObject({
      jiraKey: "DNZ-1111",
      templatePath: "custom.md",
      modelId: "claude-sonnet-4.6",
      outputFile: "out.md",
    });
  });

  test("rejects an option with no value and unknown options", () => {
    expect(parseTddCommand(["~/repos", "--jira"])).toMatchObject({
      kind: "error",
      message: "--jira requires a value.",
    });
    expect(parseTddCommand(["~/repos", "--turbo"])).toMatchObject({
      kind: "error",
      message: "Unknown option for tdd: --turbo",
    });
  });
});

describe("parseCommand", () => {
  test("routes the tdd subcommand", () => {
    expect(parseCommand(["tdd", "~/repos", "--jira", "DNZ-1"])).toMatchObject({
      kind: "tdd",
      workspaceRoot: "~/repos",
      jiraKey: "DNZ-1",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm exec vitest run test/cli/tdd-command.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the parser**

```ts
// src/cli/tdd-command.ts
/**
 * Parsing for `openwiki tdd`, the technical-design-document generator.
 *
 * Separate from the run/provider machinery for the same reason `workspace`
 * is: Copilot CLI owns its own auth and tool loop, so there is no provider
 * to configure — only a folder, an optional Jira key, and output knobs.
 */

/** A parsed `openwiki tdd` invocation. */
export interface TddCliCommand {
  exitCode: 0;
  kind: "tdd";

  /** Jira issue key to read as evidence, or null to run without Jira. */
  jiraKey: string | null;

  /** Copilot model id, or null for the backend default. */
  modelId: string | null;

  /** Where to copy the finished document, or null to leave it in the run dir. */
  outputFile: string | null;

  /** Custom template file, or null for the bundled company template. */
  templatePath: string | null;

  /** The folder holding the repositories and their `openwiki/` wiki. */
  workspaceRoot: string;
}

/** A parse failure, shaped like the CLI's other error results. */
interface TddCliError {
  exitCode: 1;
  kind: "error";
  message: string;
}

/** Options that take a value. */
const VALUE_OPTIONS = new Set([
  "--jira",
  "--model",
  "--modelId",
  "--output",
  "--template",
]);

/** Parses the arguments following `tdd`. */
export function parseTddCommand(args: string[]): TddCliCommand | TddCliError {
  let jiraKey: string | null = null;
  let modelId: string | null = null;
  let outputFile: string | null = null;
  let templatePath: string | null = null;
  let workspaceRoot: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const separator = arg.indexOf("=");
    const name =
      arg.startsWith("--") && separator > 0 ? arg.slice(0, separator) : arg;

    if (VALUE_OPTIONS.has(name)) {
      const inline =
        arg.startsWith("--") && separator > 0
          ? arg.slice(separator + 1)
          : undefined;
      const value = inline ?? args[index + 1];

      if (!value || (inline === undefined && value.startsWith("-"))) {
        return error(`${name} requires a value.`);
      }

      if (inline === undefined) index += 1;

      switch (name) {
        case "--jira":
          jiraKey = value;
          break;
        case "--model":
        case "--modelId":
          modelId = value;
          break;
        case "--output":
          outputFile = value;
          break;
        default:
          templatePath = value;
      }

      continue;
    }

    if (arg.startsWith("-")) {
      return error(`Unknown option for tdd: ${arg}`);
    }

    if (workspaceRoot === null) {
      workspaceRoot = arg;
      continue;
    }

    return error(`Unexpected argument: ${arg}`);
  }

  if (!workspaceRoot) {
    return error(
      "openwiki tdd requires a folder: openwiki tdd <folder> [--jira KEY]",
    );
  }

  return {
    exitCode: 0,
    jiraKey,
    kind: "tdd",
    modelId,
    outputFile,
    templatePath,
    workspaceRoot,
  };
}

/** Builds a parse error result. */
function error(message: string): TddCliError {
  return { exitCode: 1, kind: "error", message };
}
```

- [ ] **Step 4: Wire dispatch, env loading, runner, and help**

In `src/cli/commands.ts`:

1. Add the import next to the workspace-command import:
   `import { parseTddCommand, type TddCliCommand } from "./tdd-command.js";`
2. Add `| TddCliCommand` to the `CliCommand` union, next to `| WorkspaceCliCommand`.
3. Add the dispatch immediately after the `workspace` block:

```ts
if (argv[0] === "tdd") {
  return parseTddCommand(argv.slice(1));
}
```

4. Help content: add to `usage` (after the workspace line)
   `"openwiki tdd <folder> [--jira <KEY>] [--template <file>] [--model <id>] [--output <file>]"`,
   to `commands`

```ts
    {
      label: "openwiki tdd <folder>",
      description:
        "Fill the company technical design template with Copilot CLI: reads the workspace wiki and an optional Jira record, interviews the developer in the terminal, writes Confluence-ready Markdown.",
    },
```

and to `examples`: `"openwiki tdd ~/repos --jira DNZ-1111"`.

In `src/cli/cli.tsx`: add `|| parsedCommand.kind === "tdd"` to the
env-loading condition (so `~/.openwiki/.env` supplies the Jira vars), and the
dispatch branch after workspace:

```tsx
} else if (command.kind === "tdd") {
  await runTddCommand(command);
```

(and add `runTddCommand` to the runners import list).

In `src/cli/runners.ts` (imports: `runTdd` from `../copilot/tdd/run.js`,
`type TddCliCommand` from `./tdd-command.js`):

```ts
/**
 * Runs `openwiki tdd`: line-oriented output like the workspace runner, plus
 * the interview on the real terminal. Exit code 1 on any failure; validation
 * warnings do not fail the run — judging the document is the developer's
 * call.
 */
export async function runTddCommand(command: TddCliCommand): Promise<void> {
  try {
    const result = await runTdd({
      workspaceRoot: command.workspaceRoot,
      jiraKey: command.jiraKey,
      templatePath: command.templatePath,
      modelId: command.modelId,
      outputFile: command.outputFile,
      onEvent: (event) => {
        if (event.type === "text") {
          process.stdout.write(`${event.text.trim()}\n`);
        }
      },
    });

    process.stdout.write(`\nTDD hazır: ${result.documentPath}\n`);
    process.stdout.write(
      "İçeriği kopyalayıp Confluence'a yapıştırabilirsiniz.\n",
    );

    if (result.pendingClarifications > 0) {
      process.stdout.write(
        `${result.pendingClarifications} adet [Netleştirilecek] işareti var.\n`,
      );
    }

    for (const warning of result.warnings) {
      process.stdout.write(`Uyarı: ${warning}\n`);
    }

    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 5: Run tests, lint, commit**

Run: `corepack pnpm exec vitest run test/cli/tdd-command.test.ts test/cli/commands.test.ts` → PASS.
Run: `corepack pnpm run typecheck && corepack pnpm exec eslint . && corepack pnpm exec prettier --write src/cli/ test/cli/`

```bash
git add src/cli/tdd-command.ts src/cli/commands.ts src/cli/cli.tsx src/cli/runners.ts test/cli/tdd-command.test.ts
git commit -m "feat: openwiki tdd CLI command — parsing, dispatch, runner, help

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end verification, docs, release notes

**Files:**

- Modify: `README.md` (new section after "Many repositories, one wiki")
- Create: `.changeset/tdd-command.md`

- [ ] **Step 1: Full suite and build**

Run: `corepack pnpm run typecheck && corepack pnpm exec eslint . && corepack pnpm exec prettier --check . && corepack pnpm exec vitest run`
Expected: everything green (the suite gained ~45 tests across `test/copilot/tdd/` and `test/cli/tdd-command.test.ts`).

Run: `corepack pnpm run build && node dist/cli/cli.js tdd 2>&1 | head -2`
Expected: the parse error `openwiki tdd requires a folder: …`, exit code 1 — proving dispatch works in the built CLI.

- [ ] **Step 2: Manual smoke against the stub**

Create a throwaway workspace with an `openwiki/index.md`, point
`OPENWIKI_COPILOT_CLI_BIN` at a stub that writes `questions.json` and
`tdd.md` (reuse the shapes from Task 6's test), run
`node dist/cli/cli.js tdd <dir>`, skip the brief with Enter, answer the
question, and confirm: `tdd/adhoc-<date>/tdd.md` exists, the summary line
prints its path, and exit code is 0.

- [ ] **Step 3: README section**

Add after the "Many repositories, one wiki" section, following its tone:

```markdown
## From wiki to technical design document

`openwiki tdd` fills the company's "MVP - Teknik Detay" template for a new
project, grounded in the workspace wiki:

​`sh
openwiki tdd ~/repos --jira DNZ-1111
​`

The run reads the Jira record when a key is given (`OPENWIKI_JIRA_BASE_URL`
and `OPENWIKI_JIRA_TOKEN` — a profile Personal Access Token, sent as a
Bearer header; both can live in `~/.openwiki/.env`), asks for an optional
brief, then interviews you in the terminal — asking only what the wiki and
the Jira record cannot answer. Every answer is saved immediately, so an
interrupted session resumes where it stopped. The finished document lands in
`<workspace>/tdd/<KEY>/tdd.md` as Markdown ready to paste into Confluence,
with `[Netleştirilecek: …]` marking what still needs a human decision.

Readable Jira attachments (txt, md, csv, PDF, Word) are pulled into the
evidence; unreadable ones (images, Excel) become interview questions instead
of silently disappearing. `--template <file>` substitutes a newer company
template; `--output <file>` copies the document elsewhere.
```

(Remove the zero-width markers around the fence when pasting.)

- [ ] **Step 4: Changeset, final commit, push**

```bash
cat > .changeset/tdd-command.md <<'MD'
---
"openwiki": minor
---

feat: `openwiki tdd` — fill the company technical design template from the workspace wiki, an optional Jira record, and a terminal developer interview, via Copilot CLI
MD
corepack pnpm exec prettier --write README.md .changeset/tdd-command.md
git add README.md .changeset/tdd-command.md
git commit -m "docs: README and changeset for openwiki tdd

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push fork copilot-cli-backend:main
```

---

## Plan Self-Review (completed)

- **Spec coverage:** decisions table → Tasks 3–7 (PAT Bearer: Task 3; optional Jira: Tasks 6/7; brief+interview: Task 5; Markdown/Turkish: Tasks 4/8); five-step flow → Task 6; attachment table → Tasks 2–3; unreadable-attachment questions → Tasks 3 (list) + 4 (prompt); Confluence links listed-not-fetched → Task 3; output layout incl. `adhoc-<date>` → Task 6; template handling + `--template` → Task 1; module table → File Map (validation lives in `template.ts` beside the section model it needs — a deliberate refinement of the spec's loose assignment to `run.ts`, which still owns _calling_ it); error handling → Tasks 3/6/7; testing section → each task's tests; non-goals → nothing in this plan implements them.
- **Placeholder scan:** clean — every step carries real code or an exact command.
- **Type consistency:** `TddQuestion`, `InterviewIo`, `TddTemplate`, `TddRunOptions/Result`, `TddCliCommand` names and shapes match across Tasks 4–7; `runCopilot`'s `launcher`/`env` fields match `src/copilot/process.ts` as it exists today.
