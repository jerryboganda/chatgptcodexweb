import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getCodexConfigPath } from "../codex-integration-shared";

function normalize(path: string): string {
  let value = path.replace(/^\\\\\?\\/, "").replace(/\//g, "\\");
  value = resolve(value);
  value = value.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** The folders Codex itself marks as trusted ([projects.'<path>'] trust_level = "trusted"). */
export function trustedProjects(configPath = getCodexConfigPath()): string[] {
  try {
    if (!existsSync(configPath)) return [];
    const document = Bun.TOML.parse(readFileSync(configPath, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n")) as {
      projects?: Record<string, { trust_level?: unknown }>;
    };
    return Object.entries(document.projects ?? {})
      .filter(([, value]) => value?.trust_level === "trusted")
      .map(([path]) => normalize(path));
  } catch {
    return [];
  }
}

/** True when `cwd` is inside a folder the user trusted in Codex. */
export function insideTrustedProject(cwd: string, trusted: string[]): boolean {
  if (trusted.length === 0) return false;
  let current = normalize(cwd);
  for (let level = 0; level < 64; level += 1) {
    if (trusted.includes(current)) return true;
    const parent = normalize(dirname(current));
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/**
 * The acceptance command comes from the project (AGENTS.md, a test script) and runs outside Codex's
 * sandbox, so it only runs for a folder the user trusted in Codex, or when the session already runs
 * without approvals (bypassPermissions), where the user accepted that risk.
 */
export function mayRunProjectCommands(cwd: string, permissionMode: unknown, configPath?: string): boolean {
  if (permissionMode === "bypassPermissions") return true;
  return insideTrustedProject(cwd, trustedProjects(configPath));
}
