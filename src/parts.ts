/**
 * The task parts extractor: a sentence a person wrote, turned into the parts a completion check
 * asks about.
 *
 * This is code, not a judgment, and that is the whole design. A task is a sentence somebody typed,
 * so its parts are in the sentence: the verbs they used, the paths they named, the conjunctions
 * they joined their clauses with. None of that needs a model, and asking one would cost money on
 * every turn, drift between model versions, and answer the same string differently twice.
 *
 * Three kinds, matching `decisions/completion-check.ts` exactly:
 *
 * - `file`   something must be written to a named path. The path is a path shaped token the person
 *            actually typed. It is never guessed from the prose.
 * - `action` something must be done: a search, a fetch, a browser step, a command.
 * - `reply`  something must appear in the answer, with no file and no action attached.
 *
 * Parts come back in the order they were written, and a one clause task yields exactly one part,
 * never zero.
 *
 * ## What this parser cannot do, and will get wrong
 *
 * These are limits of parsing, not bugs to be closed by adding a judge. A wrong split is cheap and
 * visible in the ledger; a model call on every task is neither.
 *
 * 1. **Pronouns and inherited files.** "Add a --dry-run flag to scripts/deploy.mjs and make it skip
 *    the push" is two directives, and a person labelling it calls both file parts in
 *    `scripts/deploy.mjs`, because that is where the second one happens. This parser calls the
 *    second one an `action`: its clause names no path, and taking one from the clause before it
 *    means guessing what "it" refers to.
 * 2. **Elided verbs beyond the obvious.** "Write the timeline to a.md and the note to b.md" is
 *    handled, because the second conjunct carries its own path and can borrow the head clause's
 *    verb. Anything subtler stays joined to the clause before it.
 * 3. **Counted enumerations.** "Draft two replies, one accepting and one asking for a lower rate"
 *    is two drafts to a person and one clause here. Named enumerations are expanded ("the Cedar
 *    Park, Leander and Round Rock stores"); counted ones are not, because expanding "two replies"
 *    means inventing the text of each one.
 * 4. **Work hidden in an adjunct.** "Write the release notes to release-notes.md, using the commit
 *    log" is one file part here. A person may read the adjunct as a second directive, "read the
 *    commit log", and even put it first. A participial phrase is not a directive, so this parser
 *    does not promote one into a part.
 * 5. **An unknown verb under splits.** A conjunct starts a new part only when it opens with a verb
 *    this file knows, a reply marker, or its own file path. An unusual verb after "and" leaves one
 *    part where a person would write two. That direction is deliberate: under splitting keeps the
 *    directive inside a part's text, where the judge still reads it, while over splitting invents a
 *    part that nothing can satisfy.
 * 6. **No rewriting.** A person writing parts by hand turns "tell me which one to pick" into "name
 *    the recommended library". This keeps the words that were typed, with the light normalisation
 *    at `normalisePartText` and nothing more.
 *
 * Measured by `scripts/parts-eval.mjs` against the 61 tasks in `cases/completion-check-blind.json`
 * and `cases/completion-check-tuned.json`. Those two files are a development set for this
 * extractor, not a blind one: their parts were hand written by other people for the completion
 * check, but this parser was iterated against the score, so the number is an upper bound on what a
 * set nobody has looked at would give.
 */

import type { TaskPart } from "./decisions/completion-check.ts";

/**
 * A part with the positional id the extractor assigned it. `id` is the only field the completion
 * check's own `TaskPart` does not carry, so an extracted part goes anywhere a `TaskPart` goes. The
 * number in the id is the index, which is what `partQuestionId()` keys its questions on.
 */
export type ExtractedPart = TaskPart & { readonly id: string };

/** Extensions that make a token a file rather than a version number or a piece of prose. */
const FILE_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "rst", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "env", "log", "html", "htm", "css", "scss", "less", "js", "mjs",
  "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp",
  "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "sql", "graphql", "proto", "xml", "svg", "png",
  "jpg", "jpeg", "gif", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "tar",
  "gz", "lock", "plist", "tf", "tfvars",
]);

/**
 * Library names spelled like filenames. Without this list, "Node.js" in a sentence about Node reads
 * as a JavaScript file at the repo root and turns an action into a file part.
 */
const NOT_A_PATH = new Set([
  "node.js", "next.js", "nuxt.js", "vue.js", "react.js", "three.js", "d3.js", "express.js",
  "ember.js", "backbone.js", "angular.js", "alpine.js", "chart.js", "socket.io", "discord.js",
]);

/** Verbs that open a directive. A conjunct beginning with one of these is a part of its own. */
const DIRECTIVE_VERBS = new Set([
  // looking things up
  "search", "research", "find", "look", "investigate", "check", "verify", "confirm", "browse",
  "open", "visit", "navigate", "click", "scroll", "fetch", "download", "pull", "retrieve", "get",
  "scrape", "crawl", "read", "review", "scan", "watch", "monitor", "track", "inspect",
  // working things out
  "compare", "analyse", "analyze", "evaluate", "assess", "measure", "benchmark", "count",
  "calculate", "compute", "estimate", "rank", "score", "classify", "categorise", "categorize",
  "sort", "filter", "group", "identify", "determine", "diff",
  // running things
  "run", "execute", "test", "build", "compile", "deploy", "install", "upgrade", "migrate",
  "start", "stop", "restart", "enable", "disable", "configure", "set", "schedule", "sync",
  // producing things
  "write", "save", "store", "put", "record", "log", "append", "draft", "compose", "create",
  "generate", "make", "add", "insert", "document", "export", "extract", "convert", "render",
  "produce", "capture", "screenshot", "upload", "publish", "post", "send", "email", "message",
  "share", "commit", "push", "tag",
  // changing things
  "update", "edit", "revise", "rewrite", "refactor", "rename", "move", "copy", "delete", "remove",
  "fix", "patch", "repair", "correct", "implement", "wire", "clean", "tidy", "trim", "shorten",
  "expand", "merge", "combine", "split", "validate", "lint", "format",
  // answering
  "tell", "let", "report", "state", "say", "explain", "recommend", "suggest", "answer", "reply",
  "respond", "name", "give", "show", "list", "summarise", "summarize", "describe", "note",
  "highlight", "flag", "quote", "cite", "translate", "pick", "choose", "select",
]);

/**
 * Verbs whose product is the answer itself. A clause led by one of these, with no path in it, is a
 * reply part: a recommendation that was asked for is delivered by saying it and leaves no receipt.
 */
const REPLY_VERBS = new Set([
  "tell", "let", "report", "state", "say", "explain", "recommend", "suggest", "answer", "reply",
  "respond", "name", "give", "show", "list", "summarise", "summarize", "describe", "highlight",
  "quote", "cite", "pick", "choose", "select", "identify",
]);

/**
 * Verbs that consume a path instead of producing one. "Read the notes in docs/setup.md" names a
 * file and writes nothing, so it is an action: a file part means something must appear at that
 * path, and nothing here will.
 */
const READ_VERBS = new Set([
  "read", "open", "check", "review", "scan", "inspect", "view", "browse", "visit", "load",
  "search", "look", "find", "investigate", "fetch", "download", "retrieve", "get", "scrape",
  "crawl", "run", "execute", "test", "compare", "diff", "watch", "monitor", "verify", "confirm",
  "navigate", "click", "count", "measure", "benchmark", "evaluate", "assess", "analyse", "analyze",
]);

/**
 * Verbs that change something that already exists. Paired with a back reference and no target of
 * their own, they continue the file the sentence has already named.
 */
const CONTINUATION_VERBS = new Set([
  "make", "have", "keep", "add", "update", "edit", "revise", "rewrite", "refactor", "rename",
  "remove", "delete", "fix", "patch", "repair", "correct", "implement", "wire", "set", "insert",
  "append", "extend", "trim", "clean", "turn",
]);

/** Words that point back at what the sentence already named. */
const BACK_REFERENCES = new Set(["it", "them", "that", "this", "those", "these", "itself", "themselves"]);

/** Words that open an adjunct rather than a directive, so the segment belongs to its neighbour. */
const ADJUNCT_OPENERS = new Set([
  "between", "among", "using", "from", "with", "without", "after", "before", "once", "when",
  "while", "if", "unless", "given", "based", "according", "for", "in", "on", "at", "by", "of",
  "about", "against", "per", "via", "starting", "including", "excluding", "assuming", "where",
]);

/** Filler that can sit in front of a directive without changing it. */
const LEADING_FILLER =
  /^(?:and then|and|then|also|plus|next|after that|finally|lastly|first|second|third|now|please)\s+/i;

/** Phrases that name the answer as the place the work lands. */
const REPLY_PHRASE = /\s*\bin\s+(?:your|the)\s+(?:reply|response|answer|message|chat)\b/i;

/** "tell me" and friends, which a person writing parts by hand renders as "state ...". */
const TELL_ME = /^(?:please\s+)?(?:tell|let)\s+me\s+(?:know\s+)?(?:that\s+|about\s+)?/i;

/** A sentence that takes work away rather than asking for it. Dropped whole, clauses and all. */
const NEGATION_SENTENCE = /^(?:no|none|do not|don't|never|there is no|nothing)\b/i;

/** Separators a person actually writes between directives, longest first. */
const SEPARATOR_SOURCE =
  "(\\s*;\\s*|,\\s+(?:and then|and|then|also|but|plus)\\s+|,\\s+|\\s+and then\\s+|\\s+and\\s+|\\s+then\\s+|\\s+also\\s+|\\s+plus\\s+)";

/**
 * A named list inside one clause: two or more capitalised names joined by "and", ending in the
 * plural noun they share. "the Cedar Park, Leander and Round Rock stores" is three store visits to
 * anyone who reads it, and the plural noun is the only marker that says so.
 */
const NAMED_LIST =
  /\b((?:[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)(?:,\s+[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)*,?\s+and\s+(?:[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*))\s+((?:[a-z]+\s+)?[a-z]+s)\b/;

export interface PathToken {
  readonly value: string;
  /** A folder is not a file part: nothing in the receipts can be matched against it exactly. */
  readonly isDirectory: boolean;
}

/** Strips the punctuation a token picks up from the sentence around it. */
function cleanToken(raw: string): string {
  let token = raw.replace(/^[("'`[<{]+/, "").replace(/[)"'`\]>},;:!?]+$/, "");
  while (token.endsWith(".")) token = token.slice(0, -1);
  return token;
}

/** Whether one token is path shaped, and whether it names a folder rather than a file. */
export function asPathToken(raw: string): PathToken | null {
  const token = cleanToken(raw);
  if (token.length < 2) return null;
  if (token.includes("://") || token.startsWith("www.")) return null;
  if (NOT_A_PATH.has(token.toLowerCase())) return null;
  if (!/[A-Za-z]/.test(token)) return null;
  if (token.endsWith("/")) return { value: token, isDirectory: true };

  const dot = token.lastIndexOf(".");
  if (dot > 0) {
    const extension = token.slice(dot + 1).toLowerCase();
    const stem = token.slice(0, dot);
    if (FILE_EXTENSIONS.has(extension) && /[A-Za-z]/.test(stem)) {
      return { value: token, isDirectory: false };
    }
  }
  if (token.includes("/")) {
    if (/^(?:and|or|either|neither)\//i.test(token)) return null;
    // A path with no extension reads as a folder, and a folder cannot be checked exactly.
    return { value: token, isDirectory: true };
  }
  return null;
}

/** The first path shaped token in a piece of text, or null. */
export function pathTokenIn(text: string): PathToken | null {
  for (const raw of text.split(/\s+/)) {
    const token = asPathToken(raw);
    if (token !== null) return token;
  }
  return null;
}

function hasFilePath(text: string): boolean {
  const token = pathTokenIn(text);
  return token !== null && !token.isDirectory;
}

/** The verb a segment leads with, ignoring the filler in front of it. */
function leadVerb(segment: string): string {
  const cleaned = segment.replace(LEADING_FILLER, "");
  const match = cleaned.match(/^([A-Za-z][A-Za-z-]*)/);
  const word = match?.[1];
  return word === undefined ? "" : word.toLowerCase();
}

function startsDirective(segment: string): boolean {
  const verb = leadVerb(segment);
  return verb !== "" && DIRECTIVE_VERBS.has(verb);
}

function opensAdjunct(segment: string): boolean {
  const verb = leadVerb(segment);
  return verb !== "" && ADJUNCT_OPENERS.has(verb);
}

/**
 * Sentences. A full stop only ends one when what follows starts like a new sentence, which keeps
 * `notes/pg-pricing.md.` and `version 0.4.2` in one piece. A bulleted or numbered list becomes a
 * run of separated segments, because that is what the person meant by writing it as a list.
 */
export function splitSentences(task: string): string[] {
  const flattened = task
    .replace(/\r\n?/g, "\n")
    .replace(/\n\s*(?:[-*•]|\d+[.)])\s+/g, "; ")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return flattened
    .split(/(?<=[.!?])\s+(?=["'`([]?[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export interface Clause {
  /** Context the directive was written after, kept in the text and out of the classification. */
  readonly prefix: string;
  readonly text: string;
  /** The head clause's verb, when this clause borrowed it because its own was elided. */
  readonly borrowedVerb?: string;
}

interface MutableClause {
  prefix: string;
  text: string;
  borrowedVerb?: string;
}

/**
 * One sentence into its directives.
 *
 * A separator ends a clause only when what follows is itself a directive: a known verb, a reply
 * marker, or a conjunct carrying its own file path where the clause before it had one too. That is
 * what keeps "the Cedar Park and Leander store pages" and "in src/config.js and its callers" in one
 * piece, which naive splitting on "and" destroys.
 */
export function splitIntoClauses(sentence: string): Clause[] {
  const pieces = sentence.split(new RegExp(SEPARATOR_SOURCE, "gi"));
  const clauses: MutableClause[] = [];
  let current: MutableClause | null = null;
  let currentIsAdjunct = false;

  for (let index = 0; index < pieces.length; index += 2) {
    const piece = (pieces[index] ?? "").trim();
    const separatorBefore = index === 0 ? "" : (pieces[index - 1] ?? " ");
    if (piece === "") continue;

    const head: MutableClause | null = current;
    if (head === null) {
      current = { prefix: "", text: piece };
      currentIsAdjunct = opensAdjunct(piece);
      continue;
    }

    const directive = startsDirective(piece);
    const ellipsis: boolean = !directive && hasFilePath(piece) && hasFilePath(head.text);

    if (!directive && !ellipsis) {
      head.text += separatorBefore + piece;
      continue;
    }

    if (currentIsAdjunct) {
      // "Between a weekly digest and a daily one, tell me which to use": the opening is context for
      // the directive, so it stays in the text and out of what decides the kind.
      head.prefix = head.prefix + head.text + separatorBefore;
      head.text = piece;
      currentIsAdjunct = false;
      continue;
    }

    const borrowedVerb: string = ellipsis ? leadVerb(head.text) : "";
    clauses.push(head);
    current = borrowedVerb === "" ? { prefix: "", text: piece } : { prefix: "", text: piece, borrowedVerb };
  }

  if (current !== null) clauses.push(current);
  return clauses;
}

type Classified =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "action" }
  | { readonly kind: "reply" };

/**
 * What a clause asks for. A reply marker wins over a path, because a path named in passing ("using
 * the figures in data/raw.csv, tell me the busiest week") is where the work reads from, not where
 * it lands. A reading verb wins too, for the same reason: "read the notes in docs/setup.md" leaves
 * nothing at that path. A folder never wins: `save them under drafts/` cannot be checked against an
 * exact path, so it stays an action.
 */
export function classifyClause(text: string): Classified {
  if (REPLY_PHRASE.test(text)) return { kind: "reply" };
  const verb = leadVerb(text);
  if (verb !== "" && REPLY_VERBS.has(verb)) return { kind: "reply" };
  const token = pathTokenIn(text);
  if (token !== null && !token.isDirectory && !READ_VERBS.has(verb)) {
    return { kind: "file", path: token.value };
  }
  return { kind: "action" };
}

function singular(noun: string): string {
  const words = noun.trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  let one = last;
  if (/ies$/i.test(last)) one = last.slice(0, -3) + "y";
  else if (/sses$/i.test(last)) one = last.slice(0, -2);
  else if (/s$/i.test(last) && !/ss$/i.test(last)) one = last.slice(0, -1);
  words[words.length - 1] = one;
  return words.join(" ");
}

/**
 * A named list inside one clause, one clause per name. "Check the Cedar Park, Leander and Round
 * Rock stores in the browser" is three visits, and a completion check that asks about it as one
 * question cannot say which of the three was missed.
 */
export function expandNamedList(text: string): string[] {
  const match = text.match(NAMED_LIST);
  if (match === null || match.index === undefined) return [text];
  const list = match[1] ?? "";
  const head = match[2] ?? "";
  const names = list.split(/,\s+|\s+and\s+/).map((name) => name.trim()).filter((name) => name !== "");
  if (names.length < 2) return [text];
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  return names.map((name) => `${before}${name} ${singular(head)}${after}`);
}

/**
 * The text a part carries. Verbatim, with four normalisations and no rewriting:
 * the filler in front of a directive goes, "tell me X" becomes "state X" so the question built from
 * it reads as a question, "in your reply" goes once it has done its job of naming the kind, and the
 * first letter is lowered so the part reads as a fragment of the task rather than a new sentence.
 */
export function normalisePartText(raw: string, kind: TaskPart["kind"], prefix = ""): string {
  let text = raw.trim().replace(/[.,;:]+$/, "").trim();
  text = text.replace(LEADING_FILLER, "");
  if (kind === "reply") {
    // The prefix is normalised after the directive, never before it: "tell me" only becomes
    // "state" when it is the directive's own opening, not when context happens to end that way.
    text = text.replace(TELL_ME, "state ");
    text = text.replace(REPLY_PHRASE, "");
  }
  let whole = (prefix + text).replace(/\s{2,}/g, " ").trim();
  const first = whole.slice(0, 1);
  const second = whole.slice(1, 2);
  if (first !== "" && first === first.toUpperCase() && second !== second.toUpperCase()) {
    whole = first.toLowerCase() + whole.slice(1);
  }
  return whole;
}

/**
 * Whether a clause carries on the work of the file the sentence already named. "Add a --dry-run
 * flag to scripts/deploy.mjs and make it skip the push" is two directives and one file, and the
 * only marker saying so is the pronoun: the clause names no target of its own and points back at
 * one that was named.
 *
 * This is an inference, not a parse, and it is the one place in this file that guesses. It is kept
 * narrow on purpose: a change verb, a pronoun straight after it, no path anywhere in the clause,
 * and a file part earlier in the same sentence. "and add a link to the intranet" names a new thing
 * rather than pointing back, so it stays an action.
 */
export function continuesNamedFile(text: string): boolean {
  if (pathTokenIn(text) !== null) return false;
  const match = text.replace(LEADING_FILLER, "").match(/^([A-Za-z][A-Za-z-]*)\s+([A-Za-z]+)/);
  const verb = match?.[1]?.toLowerCase() ?? "";
  const object = match?.[2]?.toLowerCase() ?? "";
  return CONTINUATION_VERBS.has(verb) && BACK_REFERENCES.has(object);
}

function partAt(index: number, classified: Classified, text: string): ExtractedPart {
  const id = `part_${index}`;
  if (classified.kind === "file") return { id, kind: "file", text, path: classified.path };
  if (classified.kind === "reply") return { id, kind: "reply", text };
  return { id, kind: "action", text };
}

/**
 * Turns a task into its parts.
 *
 * Returns an empty array only for an empty task, or for one that asks for nothing at all ("Do not
 * save a file."). Every other task yields at least one part.
 */
export function extractTaskParts(task: string): ExtractedPart[] {
  if (typeof task !== "string" || task.trim() === "") return [];

  const sentences = splitSentences(task).filter((sentence) => !NEGATION_SENTENCE.test(sentence));
  if (sentences.length === 0) return [];

  const parts: ExtractedPart[] = [];
  let carried = "";

  for (let at = 0; at < sentences.length; at += 1) {
    const sentence = sentences[at] ?? "";
    const clauses = splitIntoClauses(sentence);
    const head = clauses[0];

    // A sentence that asks for nothing is context for the one after it: "The numbers live in
    // data/raw.csv. Tell me the busiest week." is one part, and the file is where to read, not
    // where to write.
    const isContext =
      clauses.length === 1 &&
      head !== undefined &&
      head.borrowedVerb === undefined &&
      !startsDirective(head.text) &&
      classifyClause(head.text).kind !== "reply";
    if (isContext && at < sentences.length - 1) {
      carried = `${carried}${sentence} `;
      continue;
    }

    /** The file this sentence has named so far, for a clause that points back at it. */
    let namedFile: string | null = null;

    for (const clause of clauses) {
      const withVerb =
        clause.borrowedVerb === undefined ? clause.text : `${clause.borrowedVerb} ${clause.text}`;
      const read = classifyClause(withVerb);
      const classified: Classified =
        read.kind === "action" && namedFile !== null && continuesNamedFile(withVerb)
          ? { kind: "file", path: namedFile }
          : read;

      const texts: string[] = classified.kind === "action" ? expandNamedList(withVerb) : [withVerb];
      for (const text of texts) {
        const one: Classified = texts.length === 1 ? classified : classifyClause(text);
        if (one.kind === "file") namedFile = one.path;
        const prefix = carried + clause.prefix;
        carried = "";
        const normalised = normalisePartText(text, one.kind, prefix);
        if (normalised === "") continue;
        parts.push(partAt(parts.length, one, normalised));
      }
    }
  }

  if (parts.length > 0) return parts;

  // Nothing in the task opened with a verb this file knows. One clause, one part, the task itself.
  const whole = sentences.join(" ");
  const classified = classifyClause(whole);
  return [partAt(0, classified, normalisePartText(whole, classified.kind))];
}
