import { describe, expect, test } from "vitest";
import { deflateRawSync } from "node:zlib";
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

/** CRC-32 (the ZIP polynomial), for the hand-built fixture archives. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a valid single-entry ZIP archive by hand (local header, central
 * directory, EOCD), so the fixtures need no archive library. `deflate`
 * exercises the reader's method-8 path; the default is a stored entry.
 */
function buildZip(
  entryName: string,
  content: Uint8Array,
  options: { deflate?: boolean } = {},
): Uint8Array {
  const name = new TextEncoder().encode(entryName);
  const payload = options.deflate
    ? new Uint8Array(deflateRawSync(content))
    : content;
  const method = options.deflate ? 8 : 0;
  const checksum = crc32(content);

  const local = new Uint8Array(30 + name.length + payload.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(8, method, true);
  localView.setUint32(14, checksum, true);
  localView.setUint32(18, payload.length, true);
  localView.setUint32(22, content.length, true);
  localView.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(payload, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(10, method, true);
  centralView.setUint32(16, checksum, true);
  centralView.setUint32(20, payload.length, true);
  centralView.setUint32(24, content.length, true);
  centralView.setUint16(28, name.length, true);
  centralView.setUint32(42, 0, true);
  central.set(name, 46);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.length, true);
  eocdView.setUint32(16, local.length, true);

  const archive = new Uint8Array(local.length + central.length + eocd.length);
  archive.set(local, 0);
  archive.set(central, local.length);
  archive.set(eocd, local.length + central.length);

  return archive;
}

/** Builds a minimal .docx: a zip with a word/document.xml. */
function buildMinimalDocx(
  paragraphs: string[],
  options: { deflate?: boolean } = {},
): Uint8Array {
  const body = paragraphs
    .map((paragraph) => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`)
    .join("");

  return buildZip(
    "word/document.xml",
    new TextEncoder().encode(
      `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
    ),
    options,
  );
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

  test("reads a deflate-compressed entry, the form real Word files use", () => {
    expect(
      extractDocxText(
        buildMinimalDocx(["Sıkıştırılmış içerik"], { deflate: true }),
      ),
    ).toContain("Sıkıştırılmış içerik");
  });

  test("rejects an archive without word/document.xml", () => {
    const zip = buildZip("other.txt", new TextEncoder().encode("x"));

    expect(() => extractDocxText(zip)).toThrow(/word\/document\.xml/u);
  });

  test("rejects data that is not a ZIP archive", () => {
    expect(() =>
      extractDocxText(new TextEncoder().encode("plain text, not a zip")),
    ).toThrow(/Not a ZIP archive/u);
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
