import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clampNumber, LONGRUN_LIMITS } from "./settings";

export type AcceptanceSource =
  | "project-file"
  | "AGENTS.md"
  | "package.json"
  | "pytest"
  | "cargo"
  | "go"
  | "dotnet"
  | "make";

export interface ProjectPlan {
  /** False when the project opted out (.longrun/off or "enabled": false). */
  enabled: boolean;
  /** The directory the plan was resolved from (nearest project root). */
  root: string;
  acceptance?: { command: string; source: AcceptanceSource; file?: string };
  maxContinuations?: number;
  timeoutMinutes?: number;
}

const MAX_LEVELS = 8;
const PROJECT_MARKERS = [
  "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg", "Makefile", ".git",
];

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").replace(/^﻿/, "");
  } catch {
    return undefined;
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** A line such as `acceptance: npm test` or `- Acceptance command: \`pytest -q\`` in AGENTS.md. */
export function parseAcceptanceLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:[-*+]\s+)?(?:\*\*)?acceptance(?:[ _-]?(?:command|check))?(?:\*\*)?\s*:\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    let command = match[1]!.trim();
    const fenced = /^`+([^`]+)`+$/.exec(command);
    if (fenced) command = fenced[1]!.trim();
    if (command.length > 0 && command.length <= 2000 && !/^(none|n\/a|off|no)$/i.test(command)) return command;
    return undefined;
  }
  return undefined;
}

function ancestors(start: string): string[] {
  const directories: string[] = [];
  let current = resolve(start);
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    if (existsSync(join(current, ".git"))) break;
    current = parent;
  }
  return directories;
}

function hasFile(directory: string, pattern: RegExp): boolean {
  try {
    return readdirSync(directory).some((name) => pattern.test(name));
  } catch {
    return false;
  }
}

function detectAcceptance(directory: string): ProjectPlan["acceptance"] {
  const manifest = readJson(join(directory, "package.json"));
  const scripts = manifest?.scripts && typeof manifest.scripts === "object" ? manifest.scripts as Record<string, unknown> : undefined;
  const test = typeof scripts?.test === "string" ? scripts.test.trim() : "";
  if (test && !/no test specified/i.test(test)) {
    const runner = existsSync(join(directory, "bun.lock")) || existsSync(join(directory, "bun.lockb")) ? "bun run test"
      : existsSync(join(directory, "pnpm-lock.yaml")) ? "pnpm test"
        : existsSync(join(directory, "yarn.lock")) ? "yarn test" : "npm test";
    return { command: runner, source: "package.json", file: join(directory, "package.json") };
  }
  const pythonProject = existsSync(join(directory, "pytest.ini")) || existsSync(join(directory, "tox.ini"))
    || /\[tool\.pytest/.test(readText(join(directory, "pyproject.toml")) ?? "")
    || (existsSync(join(directory, "tests")) && hasFile(join(directory, "tests"), /^test_.*\.py$|_test\.py$/));
  if (pythonProject) return { command: "python -m pytest -q", source: "pytest" };
  if (existsSync(join(directory, "Cargo.toml"))) return { command: "cargo test", source: "cargo" };
  if (existsSync(join(directory, "go.mod"))) return { command: "go test ./...", source: "go" };
  if (hasFile(directory, /\.(sln|csproj)$/i)) return { command: "dotnet test", source: "dotnet" };
  if (/^test\s*:/m.test(readText(join(directory, "Makefile")) ?? "")) return { command: "make test", source: "make" };
  return undefined;
}

/**
 * Decide how a project is checked, from the working directory Codex reports. An explicit setting
 * always beats detection: .codex/longrun.json, then an "acceptance:" line in AGENTS.md, then a
 * recognised test runner. The nearest directory that says anything wins.
 */
export function resolveProject(cwd: string): ProjectPlan {
  const directories = ancestors(cwd);
  let root = directories[0] ?? resolve(cwd);
  let rootChosen = false;
  const plan: ProjectPlan = { enabled: true, root };
  for (const directory of directories) {
    if (!rootChosen && PROJECT_MARKERS.some((marker) => existsSync(join(directory, marker)))) {
      root = directory;
      plan.root = directory;
      rootChosen = true;
    }
    if (existsSync(join(directory, ".longrun", "off"))) return { ...plan, enabled: false, root: directory };
    for (const file of [join(directory, ".codex", "longrun.json"), join(directory, ".longrun.json")]) {
      const config = readJson(file);
      if (!config) continue;
      if (config.enabled === false) return { ...plan, enabled: false, root: directory };
      if (typeof config.maxContinuations === "number") plan.maxContinuations = Math.round(clampNumber(config.maxContinuations, LONGRUN_LIMITS.maxContinuations, 40));
      if (typeof config.timeoutMinutes === "number") plan.timeoutMinutes = clampNumber(config.timeoutMinutes, LONGRUN_LIMITS.acceptanceTimeoutMinutes, 30);
      const command = typeof config.acceptance === "string" ? config.acceptance.trim() : "";
      if (command && command.length <= 2000 && !plan.acceptance) plan.acceptance = { command, source: "project-file", file };
    }
    if (!plan.acceptance) {
      const agents = readText(join(directory, "AGENTS.md"));
      const command = agents === undefined ? undefined : parseAcceptanceLine(agents);
      if (command) plan.acceptance = { command, source: "AGENTS.md", file: join(directory, "AGENTS.md") };
    }
    if (plan.acceptance) return plan;
  }
  const detected = detectAcceptance(root);
  if (detected) plan.acceptance = detected;
  return plan;
}
