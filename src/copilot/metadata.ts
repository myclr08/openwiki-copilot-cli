import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UpdateMetadata } from "../agent/types.js";

/** Per-repository run marker, matching the file the DeepAgents backend writes. */
export const METADATA_FILE = ".last-update.json";

/**
 * Reads a repository wiki's run marker.
 *
 * Returns null when the file is missing or unreadable — including when it is
 * corrupt. A damaged marker must cause a rebuild, never a crash.
 */
export async function readRepoMetadata(
  wikiDir: string,
): Promise<UpdateMetadata | null> {
  try {
    const raw = await readFile(path.join(wikiDir, METADATA_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);

    return typeof parsed === "object" && parsed !== null
      ? (parsed as UpdateMetadata)
      : null;
  } catch {
    return null;
  }
}

/** Records a completed (or interrupted) run for one repository's wiki. */
export async function writeRepoMetadata(
  wikiDir: string,
  metadata: UpdateMetadata,
): Promise<void> {
  await mkdir(wikiDir, { recursive: true });
  await writeFile(
    path.join(wikiDir, METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Decides whether an update can skip a repository: its recorded run completed
 * at the commit the repository is on now, and the requested language matches.
 */
export function canSkipUpdate(
  metadata: UpdateMetadata | null,
  gitHead: string | undefined,
  language: string | null | undefined,
): boolean {
  if (!metadata?.gitHead || !gitHead) return false;
  if (metadata.status === "interrupted") return false;
  if (metadata.gitHead !== gitHead) return false;

  const requested = language?.trim() || undefined;

  return requested === undefined || requested === metadata.language;
}
