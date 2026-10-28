// Jev (TypeSafe AI "System One") as the fast first line of the long-run controller. Jev answers typed questions
// with probabilities in well under a second, so it takes the routine decisions; the Codex-quota model (Luna) is only
// asked when Jev is unsure, disagrees with the built-in policy, or has to write text. Everything here is pure except
// the HTTP client, so every rule is unit-testable. Jev's answer is advice, like Luna's: the policy keeps the hard limits.
import { KIND, capText } from "./lib.mjs";

export const JEV_MODES = Object.freeze(["auto", "jev", "shadow", "luna"]);

export const JEV_DEFAULTS = Object.freeze({
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  timeoutMs: 20_000,
  retries: 2,
  // Jev's window is 32K tokens; 60K characters leaves room for the questions even at ~2.5 characters per token.
  maxStateChars: 60_000,
  // Choice confidence is (pTop - 1/n) / (1 - 1/n): 0.6 is a top probability of about 0.73 with three options, 0.85 about 0.90.
  minConfidence: 0.6,
  highConfidence: 0.85,
});

export class JevError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------------------------
// Client: POST /v1/systemone with a bearer key. The key never appears in an error message.
// ---------------------------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([408, 409, 425, 429]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response) {
  const header = response.headers?.get?.("retry-after");
  if (header === null || header === undefined || header.trim() === "") return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 10_000) : undefined;
}

export function createJevClient({
  apiKey, baseUrl = JEV_DEFAULTS.baseUrl, model = JEV_DEFAULTS.model, timeoutMs = JEV_DEFAULTS.timeoutMs,
  retries = JEV_DEFAULTS.retries, fetch: fetchImpl = globalThis.fetch, sleep = wait,
} = {}) {
  if (!apiKey) throw new JevError("no API key");
  const url = `${String(baseUrl).replace(/\/+$/, "")}/v1/systemone`;
  const scrub = (text) => String(text ?? "").split(apiKey).join("[redacted]").replace(/\s+/g, " ").trim().slice(0, 300);
  const backoff = (attempt) => Math.min(4000, 400 * 2 ** attempt);
  return {
    /** Resolves to the `answers` object keyed by question name. */
    async systemOne({ state, questions }) {
      const body = JSON.stringify({ state, questions, model });
      for (let attempt = 0; ; attempt += 1) {
        let response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json", "user-agent": "codex-chatgpt-web-longrun" },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          if (attempt < retries) { await sleep(backoff(attempt)); continue; }
          const why = error?.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : scrub(error?.cause?.code ?? error?.message);
          throw new JevError(`request failed: ${why}`, { retryable: true });
        }
        if (response.ok) {
          let json;
          try { json = await response.json(); } catch { throw new JevError("the response was not JSON"); }
          const answers = json?.answers ?? json;
          if (!answers || typeof answers !== "object") throw new JevError("the response had no answers");
          return answers;
        }
        const retryable = RETRYABLE_STATUS.has(response.status) || response.status >= 500;
        if (retryable && attempt < retries) { await sleep(retryAfterMs(response) ?? backoff(attempt)); continue; }
        const detail = scrub(await response.text().catch(() => ""));
        throw new JevError(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`, { status: response.status, retryable });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// What is sent: the controller's evidence summary with credential-looking text masked, capped to Jev's window.
// ---------------------------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  [/((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1[redacted]"],
];

export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function jevState(evidence, secrets = [], maxChars = JEV_DEFAULTS.maxStateChars) {
  return capText(redact(evidence, secrets), maxChars);
}

// ---------------------------------------------------------------------------------------------
// Questions. Descriptions mirror the Luna prompts in lib.mjs so both models judge by the same rules.
// ---------------------------------------------------------------------------------------------

export function decideQuestions() {
  return {
    action: {
      type: "choice",
      instructions: "The state is the evidence about an unattended long-running coding agent that works in a chat. How should its NEXT round run? Continue is the default when the chat is healthy, even if the last round failed for a transient reason.",
      criteria: {
        continue: "Keep working in the same chat, which keeps its full memory. The chat is healthy, or the last failure was transient (network, reconnect, a rate limit).",
        fresh: "Open a new chat that receives a written briefing. The chat looks confused, repeats itself, mixes up unrelated work or earlier tasks, contradicts the progress file or the repository, keeps failing the same way, or has lost details it should know.",
        stop: "Continuing is clearly pointless or unsafe.",
      },
    },
    health: {
      type: "score",
      instructions: "How healthy is the agent's chat context, judging only from the evidence in the state?",
      criteria: [
        "ok: the chat is coherent and on task.",
        "degraded: small drift, some repetition or a forgotten detail.",
        "polluted: the chat mixes contexts, loops, or has lost the thread of the task.",
      ],
    },
  };
}

export function watchQuestions() {
  return {
    action: {
      type: "choice",
      instructions: "The state describes an unattended long-running coding agent whose current round is still running, but nothing in the repository or its progress file has changed for a while. No change by itself is not a sign of trouble: the agent may be reading, reasoning for a long time or running tests. What is going on?",
      criteria: {
        wait: "The agent is plausibly working: long reasoning, a long build or test run, a large file being written, normal variety in its commands. This is the right answer unless there are clear signs of trouble.",
        fresh: "The chat is stuck in a loop or poisoned: the same commands or file dumps repeat, compaction or reconnect errors keep coming, it re-reads the project over and over without writing anything, or it is confused about the task.",
        restart: "The process is hung or disconnected: it has produced NO output at all for many minutes (reconnect notices do not count) but the chat itself is fine. Never choose this while output is still arriving.",
      },
    },
  };
}

export function classifyQuestions() {
  return {
    kind: {
      type: "choice",
      instructions: "The state is the error text of a failed run of a coding agent that talks to ChatGPT through a browser bridge. What kind of failure is it?",
      criteria: {
        transient: "A network, stream, browser tab, 5xx or bridge hiccup that will probably pass when retried.",
        rate_limit: "A usage limit, quota, message cap or too-many-requests message: wait before retrying.",
        auth: "The ChatGPT session is signed out or expired and needs a login.",
        context: "The chat's context window is full or compaction failed.",
        other: "None of the above, or it cannot be told from the text.",
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading answers. `confidence` is Jev's own number; when it is missing it is derived from the probabilities.
// ---------------------------------------------------------------------------------------------

function confidenceOf(answer, label) {
  if (typeof answer?.confidence === "number" && Number.isFinite(answer.confidence)) return Math.min(1, Math.max(0, answer.confidence));
  const p = answer?.probabilities;
  if (p && typeof p === "object" && label !== undefined && typeof p[label] === "number") {
    const n = Object.keys(p).length;
    return n > 1 ? Math.min(1, Math.max(0, (p[label] - 1 / n) / (1 - 1 / n))) : 1;
  }
  return 0;
}

function choiceOf(answer, allowed) {
  const label = answer?.choice;
  if (typeof label !== "string" || !allowed.includes(label)) return undefined;
  return { label, confidence: confidenceOf(answer, label), p: typeof answer.probabilities?.[label] === "number" ? answer.probabilities[label] : undefined };
}

const HEALTH_LEVELS = ["ok", "degraded", "polluted"];

/** The score is the expected level; the legend says whether levels count from 0 or 1. */
function healthOf(answer) {
  if (typeof answer?.score !== "number" || !Number.isFinite(answer.score)) return undefined;
  const keys = Object.keys(answer.legend ?? {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const level = Math.min(HEALTH_LEVELS.length - 1, Math.max(0, Math.round(answer.score - (keys[0] ?? 0))));
  return { label: HEALTH_LEVELS[level], confidence: confidenceOf(answer, answer.score) };
}

const pct = (n) => (n === undefined ? "?" : `${Math.round(n * 100)}%`);

export function decideVerdict(answers) {
  const action = choiceOf(answers?.action, ["continue", "fresh", "stop"]);
  if (!action) return undefined;
  const health = healthOf(answers?.health) ?? { label: "ok", confidence: 0 };
  return { action: action.label, actionConfidence: action.confidence, actionP: action.p, health: health.label, healthConfidence: health.confidence };
}

/**
 * Whether Jev's decide answer can stand without asking Luna. It stands when it is confident AND agrees with the
 * policy's own proposal, or when it confidently moves a healthy-looking chat to a fresh one. Everything else
 * (a stop, a low confidence, contradicting signals, a try to turn the policy's fresh chat back into a continue)
 * is not final: Luna arbitrates. `effective` is what Jev alone would do, for the agreement statistics.
 */
export function settleDecide(verdict, proposed, t = JEV_DEFAULTS) {
  if (!verdict) return { final: false };
  const pollutedSure = verdict.health === "polluted" && verdict.healthConfidence >= t.highConfidence;
  const effective = pollutedSure && verdict.action !== "stop" ? "fresh" : verdict.action;
  const contradictory = pollutedSure && verdict.action === "continue";
  const confident = verdict.actionConfidence >= t.minConfidence;
  const sure = verdict.actionConfidence >= t.highConfidence;
  const accepted = !contradictory && effective !== "stop"
    && ((confident && effective === proposed) || (sure && effective === "fresh" && proposed === "continue"));
  const contextHealth = verdict.health === "polluted" && !pollutedSure ? "degraded" : verdict.health;
  const reason = `Jev: ${verdict.action} (${pct(verdict.actionP)}, confidence ${pct(verdict.actionConfidence)}), context ${verdict.health} (confidence ${pct(verdict.healthConfidence)})`;
  return {
    final: accepted,
    effective,
    advice: accepted ? { action: effective, waitSeconds: undefined, contextHealth, reason, nextHint: "" } : undefined,
    reason,
  };
}

export function watchVerdict(answers) {
  const action = choiceOf(answers?.action, ["wait", "fresh", "restart"]);
  return action ? { action: action.label, confidence: action.confidence, p: action.p } : undefined;
}

/** `wait` stands on a confident answer; killing a round (`fresh`, `restart`) needs a high one. */
export function settleWatch(verdict, t = JEV_DEFAULTS) {
  if (!verdict) return { final: false };
  const needed = verdict.action === "wait" ? t.minConfidence : t.highConfidence;
  const reason = `Jev: ${verdict.action} (${pct(verdict.p)}, confidence ${pct(verdict.confidence)})`;
  const accepted = verdict.confidence >= needed;
  return { final: accepted, effective: verdict.action, advice: accepted ? { action: verdict.action, reason } : undefined, reason };
}

/**
 * Second opinion for an error text the regex rules could not place (they call it transient). Only recoverable kinds
 * are ever returned and only on a high confidence: a wrong rate-limit or login wait costs minutes, a wrong `fatal`
 * would end a long job, so Jev can never produce one.
 */
export function classifyVerdict(answers, t = JEV_DEFAULTS) {
  const kind = choiceOf(answers?.kind, ["transient", "rate_limit", "auth", "context", "other"]);
  if (!kind) return undefined;
  const mapped = { rate_limit: KIND.RATE_LIMIT, auth: KIND.AUTH, context: KIND.CONTEXT }[kind.label];
  return { jevKind: kind.label, kind: mapped && kind.confidence >= t.highConfidence ? mapped : undefined, confidence: kind.confidence };
}
