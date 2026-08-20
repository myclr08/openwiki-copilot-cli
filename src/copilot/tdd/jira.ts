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
