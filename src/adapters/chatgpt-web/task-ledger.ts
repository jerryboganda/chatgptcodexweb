import {
  OPAQUE_COMPACTION_NOTE,
  isReadableCompactionSummaryText,
} from "../../responses/compaction";
import {
  namespacedToolName,
  type CodexContentPart,
  type CodexMessage,
  type CodexParsedRequest,
  type CodexToolCall,
  type CodexToolResultMessage,
} from "../../types";

/**
 * The task ledger is written by the bridge from the canonical Codex history, never by the model that
 * writes a checkpoint summary. A summary can drop the task it was first given, and a fresh summarizer
 * may only ever see the newest part of an oversized history, so the facts that must survive every
 * checkpoint are carried separately: the original task, the standing instructions, and the latest
 * actions. Each later checkpoint reads the previous ledger back and rewrites it.
 *
 * Markers are plain text on their own line because ChatGPT renders angle-bracket tags as HTML and
 * drops them from the copied answer.
 */
export const TASK_LEDGER_ORIGINAL_MAX_CHARS = 6_000;
export const TASK_LEDGER_MAX_ACTIONS = 12;
export const TASK_LEDGER_ACTION_MAX_CHARS = 200;
const ACTION_DETAIL_MAX_CHARS = 100;

const MARKER_LINE = (name: string) => `^[^\\w\\n]*${name}[^\\w\\n]*`;
const LEDGER_BLOCKS = new RegExp(
  `${MARKER_LINE("TASK_LEDGER_BEGIN")}\\r?\\n[\\s\\S]*?${MARKER_LINE("TASK_LEDGER_END")}(?:\\r?\\n|$)`,
  "gm",
);
const ORIGINAL_TASK_BLOCK = new RegExp(
  `${MARKER_LINE("ORIGINAL_TASK_BEGIN")}\\r?\\n([\\s\\S]*?)\\r?\\n?${MARKER_LINE("ORIGINAL_TASK_END")}$`,
  "m",
);
// A task or file name that happens to contain one of our own marker lines must not be able to open or
// close a block of the ledger it is quoted in.
const MARKER_LOOKALIKE = /^([^\w\n]*)((?:STANDING_INSTRUCTIONS|TASK_LEDGER|ORIGINAL_TASK|RECENT_ACTIONS)_(?:BEGIN|END)|CODEX_LATEST_USER_PROMPT_JSON)([^\w\n]*)$/gm;

const neutralizeMarkers = (text: string): string => text.replace(
  MARKER_LOOKALIKE,
  (_line, before: string, marker: string, after: string) => `${before}(quoted) ${marker}${after}`,
);

/** Remove every ledger block, so a model that echoed the previous ledger cannot duplicate it. */
export function stripTaskLedger(text: string): string {
  return text.replace(LEDGER_BLOCKS, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The original task recorded by an earlier checkpoint's ledger, exactly as that ledger stored it. */
export function extractLedgerOriginalTask(checkpointText: string | undefined): string | undefined {
  const body = checkpointText?.match(ORIGINAL_TASK_BLOCK)?.[1];
  return body && body.trim() ? body : undefined;
}

function plainText(content: string | readonly CodexContentPart[]): string {
  return typeof content === "string"
    ? content
    : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

const CONTEXT_WRAPPERS = /^<(?:environment_context|user_instructions|permissions(?: instructions)?|subagent_notification|turn_aborted|codex_internal_context|goal_context|skills?_instructions|skill|collaboration_mode|user_shell_command|user_action|ide_context|plugins?_instructions|apps_instructions|system-reminder)\b/i;

function isHumanTaskText(text: string): boolean {
  const head = text.trimStart();
  if (!head) return false;
  if (CONTEXT_WRAPPERS.test(head)) return false;
  if (/^# AGENTS\.md instructions for\b/.test(head)) return false;
  if (isReadableCompactionSummaryText(text) || head.startsWith(OPAQUE_COMPACTION_NOTE)) return false;
  return true;
}

/** The first real human message of the conversation; never injected context or a checkpoint. */
function firstHumanTask(messages: readonly CodexMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user" || message.origin === "codex_skill") continue;
    const text = plainText(message.content);
    if (isHumanTaskText(text)) return text.trim();
  }
  return undefined;
}

/** Verbatim up to the cap; beyond it the middle is cut and says so, never silently. */
function capVerbatim(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[... ${(text.length - maxChars).toLocaleString("en-US")} characters of the original task omitted ...]\n${text.slice(text.length - tail)}`;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)\b\s*[=:]\s*\S+/gi,
];

function redact(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted]"), text);
}

const oneLine = (value: string, max: number): string => {
  const flat = redact(value.split(/\r?\n/).find(line => line.trim())?.replace(/\s+/g, " ").trim() ?? "");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const PATH_KEYS = ["path", "file_path", "filepath", "file", "filename", "target_file", "url", "query", "pattern", "q"] as const;

/** A short label for what a tool call did, from its arguments. Never file contents or patch bodies. */
function describeToolArguments(call: CodexToolCall): string {
  const args = call.arguments;
  for (const key of ["input", "patch", "diff"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.includes("*** Begin Patch")) {
      const files = [...value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]!.trim());
      if (files.length === 0) return "(patch)";
      const shown = files.slice(0, 3).map(file => oneLine(file, 60)).join(", ");
      return `files: ${shown}${files.length > 3 ? ` (+${files.length - 3} more)` : ""}`;
    }
  }
  for (const key of ["command", "cmd"] as const) {
    const value = args[key];
    const text = typeof value === "string" ? value
      : Array.isArray(value) && value.every(part => typeof part === "string") ? (value as string[]).join(" ")
      : undefined;
    if (text) return `\`${oneLine(text, ACTION_DETAIL_MAX_CHARS)}\``;
  }
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return `${key}=${oneLine(value, ACTION_DETAIL_MAX_CHARS)}`;
  }
  return "";
}

const EXIT_CODE_PATTERNS: readonly RegExp[] = [
  /\bexit(?:ed)?(?: with)?(?: code)?[:\s]+(-?\d+)\b/i,
  /["']?exit_code["']?\s*[:=]\s*(-?\d+)/i,
];

/** Status only: whether the call worked. The output itself, which may be a file's contents, is never quoted. */
function describeToolOutcome(result: CodexToolResultMessage | undefined): string {
  if (!result) return "no result recorded";
  const text = plainText(result.content);
  for (const pattern of EXIT_CODE_PATTERNS) {
    const code = pattern.exec(text)?.[1];
    if (code !== undefined) return Number(code) === 0 ? "ok (exit 0)" : `failed (exit ${code})`;
  }
  return result.isError ? "error" : "ok";
}

function recentActions(messages: readonly CodexMessage[]): string[] {
  const results = new Map<string, CodexToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }
  const calls: CodexToolCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) if (part.type === "toolCall") calls.push(part);
  }
  return calls.slice(-TASK_LEDGER_MAX_ACTIONS).map(call => {
    const detail = describeToolArguments(call);
    const line = `- ${namespacedToolName(call.namespace, call.name)}${detail ? ` ${detail}` : ""} -> ${describeToolOutcome(results.get(call.id))}`;
    return line.length > TASK_LEDGER_ACTION_MAX_CHARS ? `${line.slice(0, TASK_LEDGER_ACTION_MAX_CHARS - 1)}…` : line;
  });
}

export interface TaskLedgerInput {
  parsed: Pick<CodexParsedRequest, "context">;
  /** Merged standing-instruction lines, already carried forward from earlier checkpoints. */
  standingBody?: string;
  /** The newest earlier checkpoint in this history, whose ledger names the original task. */
  priorCheckpoint?: string;
}

/**
 * Render the ledger, or undefined when the history offers nothing to carry (no task, instructions or
 * actions), so a trivial summary is not padded with an empty block.
 */
export function buildTaskLedger(input: TaskLedgerInput): string | undefined {
  const messages = input.parsed.context.messages;
  const carried = extractLedgerOriginalTask(input.priorCheckpoint);
  const original = carried ?? (() => {
    const first = firstHumanTask(messages);
    return first ? capVerbatim(neutralizeMarkers(first), TASK_LEDGER_ORIGINAL_MAX_CHARS) : undefined;
  })();
  const standing = input.standingBody?.trim();
  const actions = recentActions(messages);
  if (!original && !standing && actions.length === 0) return undefined;
  return [
    "TASK_LEDGER_BEGIN",
    "Written by the bridge from the complete Codex history. It is authoritative: it does not depend on the summary below, and every later checkpoint must keep it.",
    ...(original ? ["ORIGINAL_TASK_BEGIN", original, "ORIGINAL_TASK_END"] : []),
    ...(standing ? ["STANDING_INSTRUCTIONS_BEGIN", neutralizeMarkers(standing), "STANDING_INSTRUCTIONS_END"] : []),
    ...(actions.length > 0 ? [
      "RECENT_ACTIONS_BEGIN",
      "Newest last. Names and outcomes only; file contents are not repeated.",
      ...actions.map(neutralizeMarkers),
      "RECENT_ACTIONS_END",
    ] : []),
    "TASK_LEDGER_END",
  ].join("\n");
}
