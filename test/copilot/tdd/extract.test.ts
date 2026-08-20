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

    expect(text?.length).toBeLessThanOrEqual(20_050);
  });
});
