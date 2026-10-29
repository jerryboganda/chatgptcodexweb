const SAFE_UNQUOTED = /^[A-Za-z0-9_.:\\/~@+=-]+$/;

export function posixHookArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Codex starts a hook command through cmd.exe on Windows, and a command whose program path is in
 * double quotes is not executed there (verified with Codex 0.165: such a hook never runs, with or
 * without spaces in the path). Two shapes were verified to run: plain words when nothing needs
 * quoting, and a PowerShell call with single-quoted paths when something does (a space, for example).
 */
export function windowsHookCommand(parts: string[]): string {
  if (parts.every((part) => SAFE_UNQUOTED.test(part))) return parts.join(" ");
  for (const part of parts) {
    if (/["%\r\n]/.test(part)) throw new Error("A hook path contains a character Windows cannot pass to a hook command");
  }
  const quoted = parts.map((part) => `'${part.replaceAll("'", "''")}'`).join(" ");
  return `powershell -NoProfile -NonInteractive -Command "& ${quoted}"`;
}

export function hookCommandLine(parts: string[], platform: NodeJS.Platform): string {
  return platform === "win32" ? windowsHookCommand(parts) : parts.map(posixHookArgument).join(" ");
}
