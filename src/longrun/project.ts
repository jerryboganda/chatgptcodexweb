import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clampNumber, LONGRUN_LIMITS } from "./settings";

export interface ProjectPlan {
  /** False when the project opted out (.longrun/off or "enabled": false). */
  enabled: boolean;
  /** The directory the plan was resolved from (nearest project root). */
  root: string;
  maxContinuations?: number;
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

/**
 * Find the project a Codex session works in, from the working directory Codex reports, and whether it opted out
 * (`.longrun/off` or `"enabled": false` in .codex/longrun.json). Nothing here ever runs a project command.
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
      if (typeof config.maxContinuations === "number") plan.maxContinuations = Math.round(clampNumber(config.maxContinuations, LONGRUN_LIMITS.maxContinuations, 3));
    }
  }
  return plan;
}
