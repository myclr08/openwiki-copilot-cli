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
