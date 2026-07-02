import { describe, it, expect } from "@jest/globals";
import { parseReport, extractAssistantText } from "../_shared/report";

const REPORT_BLOCK = `
## Report

STATUS: verified
CONFIDENCE: VERIFIED

### What did you verify?
- users table exists: PASS (git status clean)
- schema matches: PASS

### What could you not verify?
- (nothing)

### What feedback did you give?
none

### What do you need from me to verify this next time?
nothing

### Verification metadata
- turn_index: 1
- atomic_claims_total: 2
- atomic_claims_verified: 2
- atomic_claims_failed: 0
- atomic_claims_unverified: 0
`;

describe("parseReport", () => {
  it("parses status, confidence, and known sections", () => {
    const r = parseReport(REPORT_BLOCK, 1);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("verified");
    expect(r!.confidence).toBe("verified");
    expect(r!.summary).toContain("users table exists");
    expect(r!.sections["What did you verify?"]).toContain("users table exists");
    expect(r!.sections["What feedback did you give?"]).toContain("none");
  });

  it("is case-insensitive on STATUS and CONFIDENCE labels", () => {
    const raw = `## Report\n\nstatus: failed\nconfidence: feedback\n\n### What did you verify?\nx`;
    const r = parseReport(raw, 1);
    expect(r!.status).toBe("failed");
    expect(r!.confidence).toBe("feedback");
  });

  it("derives a sensible CONFIDENCE fallback when the agent omits it", () => {
    const cases: Array<[string, string]> = [
      ["verified", "verified"],
      ["failed", "feedback"],
      ["unsure", "failed"],
    ];
    for (const [status, expectedConf] of cases) {
      const raw = `## Report\n\nstatus: ${status}\n\n### What did you verify?\nx`;
      const r = parseReport(raw, 1);
      expect(r!.confidence).toBe(expectedConf);
    }
  });

  it("returns null when there is no ## Report block", () => {
    expect(parseReport("just some assistant prose, no report", 1)).toBeNull();
  });

  it("returns null when the block has no parseable STATUS line", () => {
    const raw = "## Report\n\nsome text but no status";
    expect(parseReport(raw, 1)).toBeNull();
  });

  it("falls back to a status-derived summary when no verified section", () => {
    const raw = `## Report\n\nstatus: unsure\n`;
    const r = parseReport(raw, 7);
    expect(r!.summary).toBe("unsure for turn 7");
  });

  it("parses a full report matching the persona output contract (failed with feedback)", () => {
    const raw = `
## Report

STATUS: failed
CONFIDENCE: feedback

### What did you verify?
- file src/main.ts exists: FAIL (file not found)
- function greet() defined: FAIL (file missing)
- npm install ran: PASS (node_modules/.package-lock.json present)

### What could you not verify?
- whether the app runs correctly (no test oracle)

### What feedback did you give?
Told builder to create src/main.ts with greet() function

### What do you need from me to verify this next time?
- a smoke test script to verify the app runs

### Verification metadata
- turn_index: 3
- atomic_claims_total: 3
- atomic_claims_verified: 1
- atomic_claims_failed: 2
- atomic_claims_unverified: 1
`;
    const r = parseReport(raw, 3);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("failed");
    expect(r!.confidence).toBe("feedback");
    expect(r!.summary).toContain("file src/main.ts exists");
    expect(r!.sections["What did you verify?"]).toContain("FAIL (file not found)");
    expect(r!.sections["What could you not verify?"]).toContain("no test oracle");
    expect(r!.sections["What feedback did you give?"]).toContain("create src/main.ts");
    expect(r!.sections["What do you need from me to verify this next time?"]).toContain("smoke test");
    expect(r!.sections["Verification metadata"]).toContain("turn_index: 3");
  });

  it("parses a report with verification metadata section", () => {
    const raw = `## Report\n\nSTATUS: verified\n\n### Verification metadata\n- atomic_claims_total: 5\n- atomic_claims_verified: 5\n`;
    const r = parseReport(raw, 2);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("verified");
    expect(r!.sections["Verification metadata"]).toContain("atomic_claims_total: 5");
  });
});

describe("extractAssistantText", () => {
  it("returns the string as-is when content is a plain string", () => {
    expect(extractAssistantText("hello")).toBe("hello");
  });

  it("concatenates text blocks and ignores other block types", () => {
    const content = [
      { type: "text", text: "part one " },
      { type: "thinking", text: "(internal)" },
      { type: "text", text: "part two" },
    ];
    expect(extractAssistantText(content)).toBe("part one \npart two");
  });

  it("returns empty string for unknown shapes", () => {
    expect(extractAssistantText(42)).toBe("");
    expect(extractAssistantText(null)).toBe("");
    expect(extractAssistantText(undefined)).toBe("");
  });
});
