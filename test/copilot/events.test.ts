import { describe, expect, test } from "vitest";
import {
  CopilotEventStream,
  parseSessionEvent,
} from "../../src/copilot/events.ts";

function line(event: unknown): string {
  return JSON.stringify(event);
}

describe("parseSessionEvent", () => {
  test("returns undefined for malformed JSON", () => {
    expect(parseSessionEvent("{not json")).toBeUndefined();
  });

  test("returns undefined when the line has no event type", () => {
    expect(parseSessionEvent('{"data":{}}')).toBeUndefined();
  });

  test("keeps the payload of a well-formed event", () => {
    expect(
      parseSessionEvent('{"type":"session.error","data":{"message":"boom"}}'),
    ).toEqual({ type: "session.error", data: { message: "boom" } });
  });
});

describe("CopilotEventStream", () => {
  test("emits assistant prose as text events", () => {
    const stream = new CopilotEventStream();

    const events = stream.push(
      line({ type: "assistant.message", data: { content: "Wrote 4 pages." } }),
    );

    expect(events).toEqual([{ type: "text", text: "Wrote 4 pages." }]);
    expect(stream.text).toBe("Wrote 4 pages.");
  });

  test("ignores sub-agent and ephemeral messages", () => {
    const stream = new CopilotEventStream();

    expect(
      stream.push(
        line({
          type: "assistant.message",
          data: { content: "inner", parentToolCallId: "call-1" },
        }),
      ),
    ).toEqual([]);
    expect(
      stream.push(
        line({
          type: "assistant.message",
          ephemeral: true,
          data: { content: "notice" },
        }),
      ),
    ).toEqual([]);
    expect(stream.text).toBe("");
  });

  test("pairs a tool completion with the name from its start event", () => {
    const stream = new CopilotEventStream();

    const start = stream.push(
      line({
        type: "tool.execution_start",
        data: {
          toolCallId: "call-7",
          toolName: "view",
          arguments: { path: "src/index.ts" },
        },
      }),
    );

    expect(start).toEqual([
      {
        type: "tool_start",
        call: 'view({"path":"src/index.ts"})',
        id: "call-7",
        input: { path: "src/index.ts" },
        // "view" is aliased so the run log phrases it as a file read.
        name: "read_file",
      },
    ]);

    expect(
      stream.push(
        line({
          type: "tool.execution_complete",
          data: { toolCallId: "call-7", success: true },
        }),
      ),
    ).toEqual([
      { type: "tool_end", id: "call-7", name: "read_file", status: "finished" },
    ]);
  });

  test("reports an unsuccessful tool call as an error end", () => {
    const stream = new CopilotEventStream();

    stream.push(
      line({
        type: "tool.execution_start",
        data: { toolCallId: "c1", toolName: "bash", arguments: {} },
      }),
    );

    expect(
      stream.push(
        line({
          type: "tool.execution_complete",
          data: { toolCallId: "c1", success: false },
        }),
      ),
    ).toEqual([{ type: "tool_end", id: "c1", name: "bash", status: "error" }]);
  });

  test("records a session error as fatal", () => {
    const stream = new CopilotEventStream();

    stream.push(
      line({
        type: "session.error",
        data: {
          errorType: "auth",
          message: "Access denied by policy settings",
        },
      }),
    );

    expect(stream.fatalError).toBe("Access denied by policy settings");
  });

  test("treats a model_call error as recoverable", () => {
    const stream = new CopilotEventStream();

    stream.push(
      line({
        type: "session.error",
        data: { errorType: "model_call", message: "retrying" },
      }),
    );

    expect(stream.fatalError).toBeUndefined();
  });

  test("keeps the first fatal error when several are reported", () => {
    const stream = new CopilotEventStream();

    stream.push(
      line({
        type: "session.error",
        data: { errorType: "a", message: "first" },
      }),
    );
    stream.push(
      line({
        type: "session.error",
        data: { errorType: "b", message: "second" },
      }),
    );

    expect(stream.fatalError).toBe("first");
  });

  test("degrades an unparsable line to a debug event instead of throwing", () => {
    const stream = new CopilotEventStream();

    const events = stream.push("<<< not json >>>");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "debug" });
  });

  test("ignores blank lines and unknown event types", () => {
    const stream = new CopilotEventStream();

    expect(stream.push("   ")).toEqual([]);
    expect(stream.push(line({ type: "session.idle", data: {} }))).toEqual([]);
  });

  test("joins successive assistant messages", () => {
    const stream = new CopilotEventStream();

    stream.push(line({ type: "assistant.message", data: { content: "one" } }));
    stream.push(line({ type: "assistant.message", data: { content: "two" } }));

    expect(stream.text).toBe("one\n\ntwo");
  });
});
