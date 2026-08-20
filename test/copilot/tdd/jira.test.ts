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
      {
        filename: "bozuk.txt",
        size: 10,
        mimeType: "text/plain",
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

    if (request.url === "/attachment/bozuk.txt") {
      response.statusCode = 500;
      response.end("Server error");
      return;
    }

    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ISSUE.fields.attachment[0].content = `${baseUrl}/attachment/analiz.txt`;
  ISSUE.fields.attachment[1].content = `${baseUrl}/attachment/akis-diyagrami.png`;
  ISSUE.fields.attachment[2].content = `${baseUrl}/attachment/bozuk.txt`;
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

  test("isolates attachment failure: failed download does not fail the whole fetch", async () => {
    const evidence = await fetchJiraEvidence("DNZ-1111", jiraEnv());

    // Should include the failed attachment in the Ekler section marked as skipped
    expect(evidence.markdown).toContain("bozuk.txt");
    expect(evidence.markdown).toContain("indirilemedi/atlandı");
    // Failed attachment should NOT be in unreadableAttachments (skipped ≠ unreadable)
    expect(evidence.unreadableAttachments).toEqual(["akis-diyagrami.png"]);
    expect(evidence.unreadableAttachments).not.toContain("bozuk.txt");
  });
});
