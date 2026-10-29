import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

/**
 * Long-run keeps a Codex task going until its acceptance check passes. These are the user-level
 * limits; a project can tighten them in .codex/longrun.json. Everything is clamped so a typo in
 * the file can never turn the loop into an unbounded one.
 */
export interface LongrunSettings {
  enabled: boolean;
  /** Only models whose id starts with one of these prefixes are supervised. */
  modelPrefixes: string[];
  /** Automatic continuations after a failed acceptance check, per user request. */
  maxContinuations: number;
  /** Wall-clock budget per user request. */
  maxHours: number;
  /** Stop after this many continuations that changed nothing and failed the same way. */
  sameFailureLimit: number;
  acceptanceTimeoutMinutes: number;
  outputTailChars: number;
}

export const DEFAULT_LONGRUN_SETTINGS: LongrunSettings = Object.freeze({
  enabled: true,
  modelPrefixes: ["chatgpt-web/"],
  maxContinuations: 40,
  maxHours: 20,
  sameFailureLimit: 5,
  acceptanceTimeoutMinutes: 30,
  outputTailChars: 6000,
});

export const LONGRUN_LIMITS = {
  maxContinuations: [1, 500],
  maxHours: [0.25, 168],
  sameFailureLimit: [2, 50],
  acceptanceTimeoutMinutes: [1, 240],
  outputTailChars: [500, 20_000],
} as const;

export function clampNumber(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function longrunDirectory(home = getConfigDir()): string {
  return join(home, "longrun");
}

export function longrunSettingsPath(home = getConfigDir()): string {
  return join(home, "longrun.json");
}

function disabledByEnvironment(env: Record<string, string | undefined>): boolean {
  return /^(0|off|false|no|disabled)$/i.test(env.CODEX_LONGRUN?.trim() ?? "");
}

export function normalizeSettings(raw: unknown): LongrunSettings {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const defaults = DEFAULT_LONGRUN_SETTINGS;
  const prefixes = Array.isArray(source.modelPrefixes)
    ? source.modelPrefixes.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  return {
    enabled: source.enabled === false ? false : true,
    modelPrefixes: prefixes.length > 0 ? prefixes.slice(0, 20) : [...defaults.modelPrefixes],
    maxContinuations: Math.round(clampNumber(source.maxContinuations, LONGRUN_LIMITS.maxContinuations, defaults.maxContinuations)),
    maxHours: clampNumber(source.maxHours, LONGRUN_LIMITS.maxHours, defaults.maxHours),
    sameFailureLimit: Math.round(clampNumber(source.sameFailureLimit, LONGRUN_LIMITS.sameFailureLimit, defaults.sameFailureLimit)),
    acceptanceTimeoutMinutes: clampNumber(source.acceptanceTimeoutMinutes, LONGRUN_LIMITS.acceptanceTimeoutMinutes, defaults.acceptanceTimeoutMinutes),
    outputTailChars: Math.round(clampNumber(source.outputTailChars, LONGRUN_LIMITS.outputTailChars, defaults.outputTailChars)),
  };
}

export function loadLongrunSettings(
  home = getConfigDir(),
  env: Record<string, string | undefined> = process.env,
): LongrunSettings {
  let raw: unknown;
  try {
    const path = longrunSettingsPath(home);
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch {
    raw = undefined;
  }
  const settings = normalizeSettings(raw);
  return disabledByEnvironment(env) ? { ...settings, enabled: false } : settings;
}

export function saveLongrunSettings(settings: Partial<LongrunSettings>, home = getConfigDir()): LongrunSettings {
  let current: unknown;
  try {
    const path = longrunSettingsPath(home);
    if (existsSync(path)) current = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch {
    current = undefined;
  }
  const next = normalizeSettings({ ...(current as object | undefined), ...settings });
  atomicWriteFile(longrunSettingsPath(home), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
