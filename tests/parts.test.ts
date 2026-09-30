import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  asPathToken,
  classifyClause,
  expandNamedList,
  extractTaskParts,
  normalisePartText,
  splitIntoClauses,
  splitSentences,
} from "../src/parts.ts";

const shape = (task: string) =>
  extractTaskParts(task).map((part) => (part.kind === "file" ? `${part.kind}:${part.path}` : part.kind));

const texts = (task: string) => extractTaskParts(task).map((part) => part.text);

test("one clause is one part, never zero", () => {
  const parts = extractTaskParts("Write the monthly sales recap to reports/sales-may.md.");
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], {
    id: "part_0",
    kind: "file",
    text: "write the monthly sales recap to reports/sales-may.md",
    path: "reports/sales-may.md",
  });

  assert.equal(extractTaskParts("Tell me whether we should pause the weekly export.").length, 1);
  assert.equal(extractTaskParts("Restart the queue worker.").length, 1);
  assert.equal(extractTaskParts("Summarise the outage.").length, 1);
});

test("the parts are in the order the person wrote them", () => {
  const task =
    "Find out which two logging libraries are most widely used, write the comparison to docs/logging-options.md, and tell me which one to pick.";
  assert.deepEqual(shape(task), ["action", "file:docs/logging-options.md", "reply"]);
  assert.deepEqual(
    extractTaskParts(task).map((part) => part.id),
    ["part_0", "part_1", "part_2"],
  );
});

test("a numbered list is a list of parts", () => {
  const task = "1. Fetch the logs\n2. Write the summary to docs/outage.md\n3. Tell me the root cause";
  assert.deepEqual(shape(task), ["action", "file:docs/outage.md", "reply"]);
  assert.deepEqual(texts(task), ["fetch the logs", "write the summary to docs/outage.md", "state the root cause"]);

  assert.deepEqual(shape("- fetch the logs\n- run the tests"), ["action", "action"]);
});

test("two files are two file parts, each with its own path", () => {
  assert.deepEqual(
    shape("Write the migration log to reports/migration-0402.md and the customer facing summary to reports/migration-0402-summary.md, then tell me the total downtime."),
    ["file:reports/migration-0402.md", "file:reports/migration-0402-summary.md", "reply"],
  );
  assert.deepEqual(
    shape("Add the JSON import to src/import.js, add tests at tests/import.test.js, and run them."),
    ["file:src/import.js", "file:tests/import.test.js", "action"],
  );
});

test("a conjunct that lost its verb borrows the one the sentence already used", () => {
  assert.deepEqual(
    texts("Write the timeline to reports/a.md and the note to reports/b.md."),
    ["write the timeline to reports/a.md", "write the note to reports/b.md"],
  );
});

test("a task with no file at all has no file part", () => {
  assert.deepEqual(
    shape("Check the Maple Hardware site for the Ridgeline cordless drill and tell me its price and whether they have it."),
    ["action", "reply"],
  );
  assert.deepEqual(
    shape("Between a monthly summary email and a weekly one for the invoice reminders, tell me which to use and why."),
    ["reply"],
  );
  assert.deepEqual(shape("Open the Cedar Park store page in the browser and read the stock count."), [
    "action",
    "action",
  ]);
});

test("a path in prose is where to read, not a file to write", () => {
  // The path is in an adjunct, so the directive is still a reply and the adjunct stays in the text.
  assert.deepEqual(shape("Using the figures in data/raw.csv, tell me the busiest week."), ["reply"]);
  assert.deepEqual(texts("Using the figures in data/raw.csv, tell me the busiest week."), [
    "using the figures in data/raw.csv, state the busiest week",
  ]);

  // A whole sentence that asks for nothing is context for the sentence after it.
  assert.deepEqual(shape("The numbers live in data/raw.csv. Tell me the busiest week."), ["reply"]);

  // A reading verb consumes a path rather than producing one, so its clause is an action.
  assert.deepEqual(shape("Read the notes in docs/setup.md and tell me what is stale."), ["action", "reply"]);
  assert.equal(classifyClause("check the config in src/config.js").kind, "action");
  assert.equal(classifyClause("run the tests in tests/export.test.js").kind, "action");
});

test("a folder is not a file part, because no exact path can be checked", () => {
  assert.deepEqual(shape("Draft a reply to the vendor and save it under drafts/."), ["action", "action"]);
  assert.equal(asPathToken("drafts/")?.isDirectory, true);
  assert.equal(asPathToken("docs/logging-options.md")?.isDirectory, false);
  assert.equal(asPathToken("CHANGELOG.md")?.value, "CHANGELOG.md");
  assert.equal(asPathToken("notes/pg-pricing.md.")?.value, "notes/pg-pricing.md");
});

test("a version number, a flag and a library are not paths", () => {
  assert.equal(asPathToken("0.4.2"), null);
  assert.equal(asPathToken("2.4"), null);
  assert.equal(asPathToken("--dry-run"), null);
  assert.equal(asPathToken("Node.js"), null);
  assert.equal(asPathToken("https://example.com/a.md"), null);
  assert.deepEqual(shape("Write a CHANGELOG entry for version 0.4.2 into CHANGELOG.md."), ["file:CHANGELOG.md"]);
  assert.deepEqual(shape("Upgrade the runner to Node.js 22 and run the tests."), ["action", "action"]);
});

test("an and inside a noun phrase does not split a clause", () => {
  assert.deepEqual(
    shape("Rename userName to username in src/auth.js and its callers, then run the tests."),
    ["file:src/auth.js", "action"],
  );
  assert.deepEqual(splitIntoClauses("Search at least five sources on solar panels and write them to docs/solar.md").length, 2);
  assert.equal(splitIntoClauses("Tell me the stock status and the price").length, 1);
});

test("a named enumeration is one part per name", () => {
  assert.deepEqual(
    texts("Check the Cedar Park, Leander and Round Rock stores in the browser and report which have the 10 pack."),
    [
      "check the Cedar Park store in the browser",
      "check the Leander store in the browser",
      "check the Round Rock store in the browser",
      "report which have the 10 pack",
    ],
  );
  assert.deepEqual(expandNamedList("check the Cedar Park and Leander store pages in the browser"), [
    "check the Cedar Park store page in the browser",
    "check the Leander store page in the browser",
  ]);
  // A count with no names is one clause: expanding it would mean inventing the text of each part.
  assert.deepEqual(expandNamedList("check the three competitor storefronts"), ["check the three competitor storefronts"]);
});

test("a clause that points back at a named file stays in that file", () => {
  assert.deepEqual(
    shape("Add a --dry-run flag to scripts/deploy.mjs and make it skip the push."),
    ["file:scripts/deploy.mjs", "file:scripts/deploy.mjs"],
  );
  // A clause that names something new does not inherit the file.
  assert.deepEqual(shape("Add a retry to lib/uploader.js and add a link on the intranet."), [
    "file:lib/uploader.js",
    "action",
  ]);
  assert.deepEqual(shape("Write the report to docs/x.md and send it to the team."), ["file:docs/x.md", "action"]);
  assert.deepEqual(shape("Fix the off by one at src/paginate.js and run the unit tests."), [
    "file:src/paginate.js",
    "action",
  ]);
});

test("a sentence that takes work away is dropped whole", () => {
  assert.deepEqual(shape("Draft the reply to the vendor in your response. Do not save a file."), ["reply"]);
  assert.deepEqual(
    texts("Explain in your reply what a hot-dip galvanized finish is. No searching needed, answer from what you know."),
    ["explain what a hot-dip galvanized finish is"],
  );
  assert.deepEqual(extractTaskParts("Do not save a file."), []);
  assert.deepEqual(extractTaskParts(""), []);
  assert.deepEqual(extractTaskParts("   "), []);
});

test("a reply marker beats a verb that usually writes", () => {
  assert.equal(classifyClause("tell me the price").kind, "reply");
  assert.equal(classifyClause("draft the reply to the vendor in your response").kind, "reply");
  assert.equal(classifyClause("write the comparison to docs/x.md").kind, "file");
  assert.equal(classifyClause("run the test suite").kind, "action");
  assert.equal(classifyClause("recommend a schedule for a 12 person team").kind, "reply");
});

test("the text is what was typed, with the filler and the marker normalised", () => {
  assert.equal(normalisePartText("Then run the tests.", "action"), "run the tests");
  assert.equal(normalisePartText("tell me how many rows you got", "reply"), "state how many rows you got");
  assert.equal(normalisePartText("let me know whether it shipped", "reply"), "state whether it shipped");
  assert.equal(normalisePartText("report the consensus in your reply", "reply"), "report the consensus");
  // An acronym keeps its capitals; a sentence opener loses one.
  assert.equal(normalisePartText("Add the JSON import to src/import.js", "file"), "add the JSON import to src/import.js");
});

test("sentences split on a full stop, not on a filename or a version", () => {
  assert.deepEqual(splitSentences("Write it into notes/pg-pricing.md. No file needed."), [
    "Write it into notes/pg-pricing.md.",
    "No file needed.",
  ]);
  assert.deepEqual(splitSentences("Write a CHANGELOG entry for version 0.4.2 into CHANGELOG.md.").length, 1);
});
