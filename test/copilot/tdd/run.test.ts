import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { COPILOT_CLI_BIN_ENV_KEY } from "../../../src/copilot/config.ts";
import {
  BUNDLED_TDD_TEMPLATE,
  parseTddTemplate,
} from "../../../src/copilot/tdd/template.ts";
import {
  JIRA_BASE_URL_ENV_KEY,
  JIRA_TOKEN_ENV_KEY,
} from "../../../src/copilot/tdd/jira.ts";
import { runTdd } from "../../../src/copilot/tdd/run.ts";
import { assistantMessage, createStubCopilot } from "../stub-copilot.ts";

/** Local YYYY-MM-DD, matching the adhoc run directory's date source. */
function localDateStamp(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

const QUESTIONS_JSON = JSON.stringify([
  { section: "1. MVP Temel Kapsamı", question: "Hangi problem çözülüyor?" },
]);

/** A tdd.md that satisfies validation for the bundled template. */
const VALID_TDD = [
  "# MVP - Teknik Detay",
  "",
  "**MVP Ad:** QR ile Ödeme",
  "",
  ...parseTddTemplate(BUNDLED_TDD_TEMPLATE).sections.map(
    (section) => `## ${section.number}. ${section.title}\n\nKapsam Dışı`,
  ),
].join("\n");

/** Creates a workspace with a minimal wiki. */
async function createWorkspaceWithWiki(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-tdd-run-"));
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "index.md"),
    "# Wiki\n\n- payment-api\n",
    "utf8",
  );
  return root;
}

/** Scripted developer: skip the brief, answer every question. */
function scriptedIo(answers: string[]) {
  const input = new PassThrough();
  input.end(["", ...answers].map((line) => `${line}\n`).join(""));
  return { input, output: new PassThrough() };
}

let previousBinary: string | undefined;

beforeEach(() => {
  previousBinary = process.env[COPILOT_CLI_BIN_ENV_KEY];
});

afterEach(() => {
  if (previousBinary === undefined) delete process.env[COPILOT_CLI_BIN_ENV_KEY];
  else process.env[COPILOT_CLI_BIN_ENV_KEY] = previousBinary;
});

async function useStub(files: Record<string, string>) {
  const stub = await createStubCopilot({
    events: [assistantMessage("Tamam.")],
    files,
  });
  process.env[COPILOT_CLI_BIN_ENV_KEY] = stub.binary;
  return stub;
}

describe("runTdd", () => {
  test("produces the document through analysis, interview, and writing", async () => {
    const root = await createWorkspaceWithWiki();
    const stub = await useStub({
      "questions.json": QUESTIONS_JSON,
      "tdd.md": VALID_TDD,
    });

    const result = await runTdd({
      workspaceRoot: root,
      io: scriptedIo(["Mobil QR ödeme."]),
    });

    expect(result.warnings).toEqual([]);
    expect(await readFile(result.documentPath, "utf8")).toContain(
      "MVP - Teknik Detay",
    );
    // Two Copilot invocations: analysis, then writing.
    expect(await stub.invocations()).toHaveLength(2);
    // The interview answer reached the evidence.
    expect(
      await readFile(path.join(result.runDir, "answers.md"), "utf8"),
    ).toContain("Mobil QR ödeme.");
  });

  test("names the run directory adhoc-<date> without a Jira key", async () => {
    const root = await createWorkspaceWithWiki();
    await useStub({ "questions.json": QUESTIONS_JSON, "tdd.md": VALID_TDD });

    const result = await runTdd({
      workspaceRoot: root,
      io: scriptedIo(["Cevap."]),
    });

    expect(path.basename(result.runDir)).toMatch(/^adhoc-\d{4}-\d{2}-\d{2}$/u);
  });

  test("grants the wiki as a read directory to both passes", async () => {
    const root = await createWorkspaceWithWiki();
    const stub = await useStub({
      "questions.json": QUESTIONS_JSON,
      "tdd.md": VALID_TDD,
    });

    await runTdd({ workspaceRoot: root, io: scriptedIo(["Cevap."]) });

    for (const invocation of await stub.invocations()) {
      expect(invocation.args).toContain(path.join(root, "openwiki"));
      expect(invocation.cwd).toContain(path.join(root, "tdd"));
    }
  });

  test("refuses a workspace without a wiki", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-tdd-nowiki-"));
    await useStub({});

    await expect(
      runTdd({ workspaceRoot: root, io: scriptedIo([]) }),
    ).rejects.toThrow(/openwiki workspace/u);
  });

  test("resumes: existing questions.json skips the analysis pass", async () => {
    const root = await createWorkspaceWithWiki();
    const stub = await useStub({ "tdd.md": VALID_TDD });
    const runDir = path.join(root, "tdd", `adhoc-${localDateStamp()}`);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "questions.json"),
      QUESTIONS_JSON,
      "utf8",
    );
    await writeFile(path.join(runDir, "brief.md"), "Var olan brief.\n", "utf8");

    await runTdd({ workspaceRoot: root, io: scriptedIo(["Cevap."]) });

    // Only the writing pass ran; brief was not re-asked (no leading "" line
    // consumed: the scripted io's first line answered the interview).
    expect(await stub.invocations()).toHaveLength(1);
  });

  test("a skipped brief is not re-asked, and its emptiness excludes it from the analysis prompt", async () => {
    const root = await createWorkspaceWithWiki();
    const runDir = path.join(root, "tdd", `adhoc-${localDateStamp()}`);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "brief.md"), "", "utf8");
    const stub = await useStub({
      "questions.json": QUESTIONS_JSON,
      "tdd.md": VALID_TDD,
    });

    const input = new PassThrough();
    input.end("Mobil QR ödeme.\n");

    await runTdd({
      workspaceRoot: root,
      io: { input, output: new PassThrough() },
    });

    // The existing (empty) brief.md meant askBrief was never called, so the
    // scripted line answered the interview's question rather than being
    // consumed (and discarded) as the brief.
    const answers = await readFile(path.join(runDir, "answers.md"), "utf8");
    expect(answers).toContain("Mobil QR ödeme.");
    expect(answers).not.toContain("geç");

    const invocations = await stub.invocations();
    const analysisPrompt = invocations[0].args.join("\n");
    expect(analysisPrompt).not.toContain("brief.md");
  });

  test("a failed Jira fetch leaves no run directory behind", async () => {
    const root = await createWorkspaceWithWiki();
    const stub = await useStub({});
    const jiraKey = "DNZ-1";
    const env = { ...process.env, [COPILOT_CLI_BIN_ENV_KEY]: stub.binary };
    delete env[JIRA_BASE_URL_ENV_KEY];
    delete env[JIRA_TOKEN_ENV_KEY];

    await expect(
      runTdd({
        workspaceRoot: root,
        jiraKey,
        io: scriptedIo([]),
        env,
      }),
    ).rejects.toThrow(/Jira access needs/u);

    await expect(stat(path.join(root, "tdd", jiraKey))).rejects.toThrow();
  });

  test("reports validation warnings without failing the run", async () => {
    const root = await createWorkspaceWithWiki();
    await useStub({
      "questions.json": QUESTIONS_JSON,
      "tdd.md": "# Eksik doküman\n\n## 1. MVP Temel Kapsamı\n\n[Örn: doldur]",
    });

    const result = await runTdd({
      workspaceRoot: root,
      io: scriptedIo(["Cevap."]),
    });

    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("fails clearly when the writing pass produces no tdd.md", async () => {
    const root = await createWorkspaceWithWiki();
    await useStub({ "questions.json": QUESTIONS_JSON });

    await expect(
      runTdd({ workspaceRoot: root, io: scriptedIo(["Cevap."]) }),
    ).rejects.toThrow(/tdd\.md/u);
  });

  test("copies the document to --output when given", async () => {
    const root = await createWorkspaceWithWiki();
    await useStub({ "questions.json": QUESTIONS_JSON, "tdd.md": VALID_TDD });
    const outputFile = path.join(root, "cikti", "dokuman.md");

    const result = await runTdd({
      workspaceRoot: root,
      outputFile,
      io: scriptedIo(["Cevap."]),
    });

    expect(result.documentPath).toBe(outputFile);
    expect(await readFile(outputFile, "utf8")).toContain("MVP - Teknik Detay");
  });
});
