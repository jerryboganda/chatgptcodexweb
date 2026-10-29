import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRIVER_END, DRIVER_START, driverInstructions, ensureDriverInstructions, removeDriverBlock, upsertDriverBlock,
} from "../src/longrun/driver";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "longrun-driver-"));
  cleanup.push(path);
  return path;
}

const SETTINGS = { workerModel: "chatgpt-web/gpt-6-sol", workerEffort: "high" } as const;

test("the instructions name the worker model and effort and only ask something of a main-agent Luna", () => {
  const text = driverInstructions(SETTINGS);
  expect(text).toContain("`chatgpt-web/gpt-6-sol`");
  expect(text).toContain("at `high` effort");
  expect(text).toContain("only if you are a Luna model");
  expect(text).not.toContain("plain question or explanation that changes no files");
  expect(text).toContain("analysis, architecture explanation, code review or investigation");
  expect(text).toContain("any other model, or a subagent, ignore this section");
  expect(driverInstructions({ ...SETTINGS, workerEffort: "xhigh" })).toContain("at `xhigh` effort");
});

test("the block is added after existing text, replaced in place and removed without touching the rest", () => {
  const mine = "# My notes\n\nAlways use tabs.\n";
  const added = upsertDriverBlock(mine, SETTINGS);
  expect(added.changed).toBe(true);
  expect(added.text.startsWith(mine)).toBe(true);
  expect(added.text).toContain(DRIVER_START);
  expect(upsertDriverBlock(added.text, SETTINGS).changed).toBe(false);
  const changed = upsertDriverBlock(added.text, { ...SETTINGS, workerEffort: "xhigh" });
  expect(changed.changed).toBe(true);
  expect(changed.text.split(DRIVER_START).length).toBe(2);
  expect(changed.text).toContain("`xhigh`");
  expect(removeDriverBlock(changed.text)).toEqual({ text: mine, removed: true });
  expect(removeDriverBlock(mine)).toEqual({ text: mine, removed: false });
});

test("CRLF files stay CRLF and a damaged marker pair is never edited", () => {
  const crlf = "# Notes\r\n\r\nUse tabs.\r\n";
  const added = upsertDriverBlock(crlf, SETTINGS).text;
  expect(added.replace(/\r\n/g, "")).not.toContain("\n");
  expect(removeDriverBlock(added).text).toBe(crlf);
  const damaged = `${DRIVER_START}\nhalf`;
  expect(() => upsertDriverBlock(damaged, SETTINGS)).toThrow("edited by hand");
  expect(() => removeDriverBlock(`${damaged}\n${DRIVER_END}\n${DRIVER_END}`)).toThrow("edited by hand");
});

test("ensure creates the file only when the route is installed, and deleting the block deletes a file that held nothing else", () => {
  const dir = temp();
  const filePath = join(dir, "AGENTS.md");
  expect(ensureDriverInstructions({ filePath, settings: SETTINGS, enabled: true, routeInstalled: false })).toEqual({ action: "skipped", reason: "the Codex route is not installed" });
  expect(existsSync(filePath)).toBe(false);
  expect(ensureDriverInstructions({ filePath, settings: SETTINGS, enabled: true, routeInstalled: true })).toEqual({ action: "installed" });
  expect(readFileSync(filePath, "utf8")).toContain(DRIVER_START);
  expect(ensureDriverInstructions({ filePath, settings: SETTINGS, enabled: true, routeInstalled: true })).toEqual({ action: "unchanged" });
  expect(ensureDriverInstructions({ filePath, settings: { ...SETTINGS, workerEffort: "medium" }, enabled: true, routeInstalled: true })).toEqual({ action: "updated" });
  expect(ensureDriverInstructions({ filePath, settings: SETTINGS, enabled: false, routeInstalled: true })).toEqual({ action: "removed" });
  expect(existsSync(filePath)).toBe(false);
  expect(ensureDriverInstructions({ filePath, settings: SETTINGS, enabled: false, routeInstalled: true })).toEqual({ action: "absent" });
});

test("a user's own AGENTS.md survives install and removal and keeps its BOM", () => {
  const dir = temp();
  const filePath = join(dir, "AGENTS.md");
  writeFileSync(filePath, "\uFEFFMy rules\n");
  ensureDriverInstructions({ filePath, settings: SETTINGS, enabled: true, routeInstalled: true });
  expect(readFileSync(filePath, "utf8").startsWith("\uFEFFMy rules\n")).toBe(true);
  ensureDriverInstructions({ filePath, settings: SETTINGS, enabled: false, routeInstalled: true });
  expect(readFileSync(filePath, "utf8")).toBe("\uFEFFMy rules\n");
});

test("the instructions carry the exact worker command and do not point at the subagent tool", () => {
  const command = "& 'C:/x/bun.exe' 'C:/x/cli.js' --home 'C:/h' worker run";
  const text = driverInstructions(SETTINGS, command);
  expect(text).toContain(`\`${command} --brief-file .longrun/brief.md\``);
  expect(text).toContain("Do not use the subagent tool for this.");
  expect(text).toContain("3600000 ms");
  const block = upsertDriverBlock("", SETTINGS, "node cli.js worker run");
  expect(upsertDriverBlock(block.text, SETTINGS, "node cli.js worker run").changed).toBe(false);
  expect(upsertDriverBlock(block.text, SETTINGS, "node other.js worker run").changed).toBe(true);
});
