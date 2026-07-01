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
