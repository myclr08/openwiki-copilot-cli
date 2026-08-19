import { FilesystemBackend } from "deepagents";
import { validateWikiInternalLinks } from "../agent/wiki-link-validator.js";
import type { WikiLinkReport } from "../agent/wiki-link-validator.js";
import { validateWikiMermaid } from "../mermaid/wiki.js";
import type { WikiMermaidReport } from "../mermaid/wiki.js";
import {
  resolveConceptTypeLabel,
  resolveIndexLabels,
} from "../okf/index-labels.js";
import { migrateWikiToOkf, synchronizeWikiIndexes } from "../okf/index-sync.js";

/** What the deterministic passes changed in one repository's wiki. */
export interface PostProcessReport {
  links: WikiLinkReport;
  mermaid: WikiMermaidReport;
}

/**
 * Runs OpenWiki's deterministic conformance passes over a wiki directory that
 * Copilot just wrote.
 *
 * These are the same passes the DeepAgents backend runs after its agent
 * finishes, which is what keeps the two backends' output interchangeable: OKF
 * front matter is normalized, directory indexes are regenerated, invalid
 * Mermaid is degraded to text, and broken internal links are stamped in place
 * for the next update to repair.
 *
 * The wiki is mounted as its own root, so every pass sees `/` as the wiki and
 * cannot reach the source repository.
 */
export async function postProcessWiki(
  wikiDir: string,
  language?: string | null,
): Promise<PostProcessReport> {
  const backend = new FilesystemBackend({
    rootDir: wikiDir,
    virtualMode: true,
  });
  const resolvedLanguage = language?.trim() || undefined;
  const labels = resolveIndexLabels(resolvedLanguage);
  const conceptType = resolveConceptTypeLabel(resolvedLanguage);

  await migrateWikiToOkf(backend, "local-wiki", conceptType);
  const mermaid = await validateWikiMermaid(backend, "local-wiki");
  await synchronizeWikiIndexes(backend, "local-wiki", labels, conceptType);
  const links = await validateWikiInternalLinks(backend, "local-wiki");

  return { links, mermaid };
}
