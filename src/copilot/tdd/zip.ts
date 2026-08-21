import { inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP entry reader on Node built-ins.
 *
 * This exists so reading a .docx (a ZIP archive holding XML) needs no
 * third-party archive dependency: company policy bars some of them, and the
 * need here is tiny — find one named entry and decompress it. Only what a
 * real-world .docx uses is supported: stored (method 0) and deflate
 * (method 8) entries, located through the central directory.
 */

/** End of central directory signature ("PK\x05\x06"). */
const EOCD_SIGNATURE = 0x06054b50;

/** Central directory file header signature ("PK\x01\x02"). */
const CENTRAL_SIGNATURE = 0x02014b50;

/** Local file header signature ("PK\x03\x04"). */
const LOCAL_SIGNATURE = 0x04034b50;

/** The EOCD record's fixed size; a trailing archive comment may follow it. */
const EOCD_SIZE = 22;

/** Maximum ZIP archive comment length, bounding the EOCD search. */
const MAX_COMMENT = 0xffff;

/**
 * Extracts one named entry from a ZIP archive, decompressed.
 *
 * Returns undefined when the entry does not exist. Throws when the data is
 * not a ZIP archive at all, or the entry uses a compression method a .docx
 * never does.
 */
export function readZipEntry(
  data: Uint8Array,
  entryName: string,
): Uint8Array | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEndOfCentralDirectory(view);

  if (eocd === undefined) {
    throw new Error("Not a ZIP archive: end-of-central-directory not found.");
  }

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error("Corrupt ZIP archive: bad central directory entry.");
    }

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(
      data.subarray(offset + 46, offset + 46 + nameLength),
    );

    if (name === entryName) {
      return readLocalEntry(data, view, localOffset, compressedSize, method);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return undefined;
}

/** Locates the EOCD record by scanning backward past any archive comment. */
function findEndOfCentralDirectory(view: DataView): number | undefined {
  const start = view.byteLength - EOCD_SIZE;
  const floor = Math.max(0, start - MAX_COMMENT);

  for (let offset = start; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      return offset;
    }
  }

  return undefined;
}

/**
 * Reads an entry's bytes via its local header. Sizes come from the central
 * directory: a streamed local header may carry zeros with a data descriptor
 * after the payload, but the central record is always authoritative.
 */
function readLocalEntry(
  data: Uint8Array,
  view: DataView,
  localOffset: number,
  compressedSize: number,
  method: number,
): Uint8Array {
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
    throw new Error("Corrupt ZIP archive: bad local file header.");
  }

  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const compressed = data.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) {
    return compressed;
  }

  if (method === 8) {
    return new Uint8Array(inflateRawSync(compressed));
  }

  throw new Error(`Unsupported ZIP compression method: ${method}.`);
}
