import { expect, test } from "bun:test";
import { carryForwardStandingInstructions } from "../src/adapters/chatgpt-web/compaction-handoff";

const prior = [
  "Checkpoint",
  "STANDING_INSTRUCTIONS_BEGIN",
  "1. The vault code is HIGH-2718-KR.",
  "2. Every reply must end with the exact token HIGHTOK-7.",
  "3. The deploy region is LIMA-52.",
  "4. Always use tabs, never spaces.",
  "STANDING_INSTRUCTIONS_END",
  "Work so far",
].join("\n");

test("a standing instruction dropped by a later checkpoint is restored, never duplicated", () => {
  const next = [
    "STANDING_INSTRUCTIONS_BEGIN",
    "- End every reply with HIGHTOK-7",
    "- Deploy region: LIMA-52",
    "- Always use tabs, never spaces.",
    "STANDING_INSTRUCTIONS_END",
    "Work log",
  ].join("\n");
  const merged = carryForwardStandingInstructions(next, prior);
  expect(merged).toContain("The vault code is HIGH-2718-KR.");
  expect(merged.match(/HIGHTOK-7/g)).toHaveLength(1);
  expect(merged.match(/LIMA-52/g)).toHaveLength(1);
  expect(merged.endsWith("Work log")).toBeTrue();
});

test("a checkpoint without the block receives the previous block in full", () => {
  const merged = carryForwardStandingInstructions("Only a work log.", prior);
  expect(merged.startsWith("STANDING_INSTRUCTIONS_BEGIN\n1. The vault code is HIGH-2718-KR.")).toBeTrue();
  expect(merged).toContain("4. Always use tabs, never spaces.");
  expect(merged.endsWith("Only a work log.")).toBeTrue();
});

test("nothing changes without a previous block or when nothing was dropped", () => {
  expect(carryForwardStandingInstructions("summary", undefined)).toBe("summary");
  expect(carryForwardStandingInstructions("summary", "a checkpoint with no block")).toBe("summary");
  const block = prior.slice(prior.indexOf("STANDING_INSTRUCTIONS_BEGIN"), prior.indexOf("Work so far"));
  expect(carryForwardStandingInstructions(block, prior)).toBe(block);
});

test("a previous block that would grow the new one past its cap is not merged", () => {
  const big = `STANDING_INSTRUCTIONS_BEGIN\n${"filler line without codes\n".repeat(900)}STANDING_INSTRUCTIONS_END`;
  expect(carryForwardStandingInstructions(big, prior)).toBe(big);
});

test("decorated markers are recognised and the guidance sentence itself is not a block", () => {
  const decorated = "**STANDING_INSTRUCTIONS_BEGIN**\n- End every reply with HIGHTOK-7\n- Deploy region: LIMA-52\n- Always use tabs, never spaces.\n**STANDING_INSTRUCTIONS_END**\nlog";
  const merged = carryForwardStandingInstructions(decorated, prior);
  expect(merged).toContain("The vault code is HIGH-2718-KR.");
  const inline = "Start with STANDING_INSTRUCTIONS_BEGIN then facts then STANDING_INSTRUCTIONS_END inline.";
  expect(carryForwardStandingInstructions("summary", inline)).toBe("summary");
});
