import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

/**
 * Long-run keeps a Luna-driven Codex task going until its work is committed and pushed. It never runs tests or builds:
 * the only check is the GitHub Actions run after the push. These are the user-level limits; a project can tighten
 * them in .codex/longrun.json. Everything is clamped so a typo in the file can never turn the loop into an unbounded one.
 */
export interface LongrunSettings {
  enabled: boolean;
  /** Only models whose id starts with one of these prefixes are supervised. */
  modelPrefixes: string[];
  /** How often a driver that stops with unshipped work is sent back to commit and push it, per user request. */
  maxContinuations: number;
  /** Wall-clock budget per user request. */
  maxHours: number;
  /**
   * "Luna drives, Sol works": a native Luna model on the Codex quota runs the task and hands the coding to
   * a ChatGPT web worker. The Stop hook supervises these driver models as well.
   */
  driver: boolean;
  driverModelPrefixes: string[];
  workerModel: string;
  workerEffort: WorkerEffort;
}

export const WORKER_EFFORTS = ["medium", "high", "xhigh"] as const;
export type WorkerEffort = typeof WORKER_EFFORTS[number];

export const DEFAULT_LONGRUN_SETTINGS: LongrunSettings = Object.freeze({
  enabled: true,
  modelPrefixes: ["chatgpt-web/"],
  driver: true,
  driverModelPrefixes: ["gpt-6-luna", "gpt-5.6-luna"],
  workerModel: "chatgpt-web/gpt-6-sol",
  workerEffort: "xhigh" as WorkerEffort,
  maxContinuations: 3,
  maxHours: 20,
});

export const LONGRUN_LIMITS = {
  maxContinuations: [1, 20],
  maxHours: [0.25, 168],
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
  const driverPrefixes = Array.isArray(source.driverModelPrefixes)
    ? source.driverModelPrefixes.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  const workerModel = typeof source.workerModel === "string" && /^chatgpt-web\/[A-Za-z0-9._-]{1,80}$/.test(source.workerModel.trim())
    ? source.workerModel.trim() : defaults.workerModel;
  const workerEffort = WORKER_EFFORTS.find((effort) => effort === source.workerEffort) ?? defaults.workerEffort;
  return {
    enabled: source.enabled === false ? false : true,
    modelPrefixes: prefixes.length > 0 ? prefixes.slice(0, 20) : [...defaults.modelPrefixes],
    driver: source.driver === false ? false : true,
    driverModelPrefixes: driverPrefixes.length > 0 ? driverPrefixes.slice(0, 20) : [...defaults.driverModelPrefixes],
    workerModel,
    workerEffort,
    maxContinuations: Math.round(clampNumber(source.maxContinuations, LONGRUN_LIMITS.maxContinuations, defaults.maxContinuations)),
    maxHours: clampNumber(source.maxHours, LONGRUN_LIMITS.maxHours, defaults.maxHours),
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
