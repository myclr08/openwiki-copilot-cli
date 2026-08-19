import { sanitizeDiagnosticText } from "../platform/diagnostics.js";
import type { OpenWikiRunEvent } from "../agent/types.js";
import type { CopilotSessionEvent } from "./types.js";

/**
 * Copilot CLI tool names mapped onto the tool vocabulary the run log already
 * knows how to phrase. This is display only: an unmapped name passes through
 * and renders with the generic phrasing, so a new Copilot tool degrades to a
 * plain label rather than breaking the log.
 */
const TOOL_NAME_ALIASES = new Map<string, string>([
  ["apply_patch", "edit_file"],
  ["create", "write_file"],
  ["edit", "edit_file"],
  ["read", "read_file"],
  ["search", "grep"],
  ["str_replace_editor", "edit_file"],
  ["view", "read_file"],
  ["write", "write_file"],
]);

/**
 * Copilot error types that describe a recoverable hiccup rather than a run
 * failure. Copilot itself treats `model_call` as a warning and keeps going, so
 * the backend must not turn one into a failed repository.
 */
const NON_FATAL_ERROR_TYPES = new Set(["model_call"]);

/** Characters of tool arguments kept in the run log's call detail. */
const MAX_CALL_DETAIL = 160;

/**
 * Translates Copilot CLI's JSONL session stream into OpenWiki run events.
 *
 * Copilot emits one JSON object per line: `assistant.message` for prose,
 * `tool.execution_start` / `tool.execution_complete` for tool calls, and
 * `session.error` / `session.warning` for problems. Only the start event
 * carries the tool name, so the stream remembers names by call id to label the
 * matching completion.
 *
 * Every unrecognized or malformed line degrades to a debug event. A schema
 * change in a future Copilot release must never crash a run.
 */
export class CopilotEventStream {
  /** Assistant prose emitted so far, in order. */
  private readonly messages: string[] = [];

  /** Tool names by call id, so a completion can be labeled. */
  private readonly toolNames = new Map<string, string>();

  /** The first fatal error reported by the session, if any. */
  private fatal: string | undefined;

  /** The first fatal `session.error` message, or undefined on a clean run. */
  get fatalError(): string | undefined {
    return this.fatal;
  }

  /** Every assistant message from the run, joined by blank lines. */
  get text(): string {
    return this.messages.join("\n\n").trim();
  }

  /**
   * Consumes one line of JSONL output and returns the run events it produces.
   * Blank lines produce nothing.
   */
  push(line: string): OpenWikiRunEvent[] {
    const trimmed = line.trim();

    if (!trimmed) return [];

    const event = parseSessionEvent(trimmed);

    if (!event) {
      return [
        {
          type: "debug",
          message: `copilot.unparsed=${sanitizeDiagnosticText(truncate(trimmed, 200))}`,
        },
      ];
    }

    return this.translate(event);
  }

  private translate(event: CopilotSessionEvent): OpenWikiRunEvent[] {
    const data = event.data ?? {};

    switch (event.type) {
      case "assistant.message": {
        // Sub-agent chatter (a message produced inside a tool call) and
        // ephemeral notices are noise in the run log; only top-level turns are
        // the agent talking to us.
        if (event.ephemeral || data.parentToolCallId) return [];

        const content = readString(data, "content");

        if (!content?.trim()) return [];

        this.messages.push(content.trim());
        return [{ type: "text", text: content }];
      }

      case "tool.execution_start": {
        const id = readString(data, "toolCallId");
        const rawName = readString(data, "toolName") ?? "tool";

        if (!id) return [];

        const name = TOOL_NAME_ALIASES.get(rawName) ?? rawName;
        this.toolNames.set(id, name);

        return [
          {
            type: "tool_start",
            call: sanitizeDiagnosticText(
              `${rawName}(${formatArguments(data.arguments)})`,
            ),
            id,
            input: data.arguments,
            name,
          },
        ];
      }

      case "tool.execution_complete": {
        const id = readString(data, "toolCallId");

        if (!id) return [];

        const name = this.toolNames.get(id) ?? "tool";
        this.toolNames.delete(id);

        return [
          {
            type: "tool_end",
            id,
            name,
            status: data.success === false ? "error" : "finished",
          },
        ];
      }

      case "session.error": {
        const message =
          readString(data, "message") ?? "Copilot reported an error.";
        const errorType = readString(data, "errorType") ?? "unknown";

        if (!NON_FATAL_ERROR_TYPES.has(errorType)) {
          this.fatal ??= message;
        }

        return [
          {
            type: "debug",
            message: `copilot.error type=${errorType} ${sanitizeDiagnosticText(message)}`,
          },
        ];
      }

      case "session.warning": {
        const message = readString(data, "message") ?? "";

        return [
          {
            type: "debug",
            message: `copilot.warning ${sanitizeDiagnosticText(message)}`,
          },
        ];
      }

      default:
        return [];
    }
  }
}

/** Parses one JSONL line into a session event, or undefined when malformed. */
export function parseSessionEvent(
  line: string,
): CopilotSessionEvent | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;

  if (typeof record.type !== "string") return undefined;

  return {
    type: record.type,
    ...(typeof record.timestamp === "string"
      ? { timestamp: record.timestamp }
      : {}),
    ...(typeof record.ephemeral === "boolean"
      ? { ephemeral: record.ephemeral }
      : {}),
    ...(typeof record.data === "object" && record.data !== null
      ? { data: record.data as Record<string, unknown> }
      : {}),
  };
}

/** Reads a string field from an event payload, or undefined when absent. */
function readString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

/** Renders tool arguments compactly for the run log's call detail. */
function formatArguments(input: unknown): string {
  if (input === undefined || input === null) return "";

  if (typeof input === "string") return truncate(input, MAX_CALL_DETAIL);

  try {
    return truncate(JSON.stringify(input) ?? "", MAX_CALL_DETAIL);
  } catch {
    return "";
  }
}

/** Truncates to `limit` characters with a trailing ellipsis. */
function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
