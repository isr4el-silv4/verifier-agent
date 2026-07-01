/**
 * Pure report-parsing helpers extracted from the verifier child for testability.
 *
 * `parseReport` pulls the `## Report` block out of an assistant message and
 * splits it into its known H3 sections. `extractAssistantText` flattens an
 * assistant message's content into plain text. Both are deterministic and
 * side-effect free.
 */

import type { Confidence } from "./ipc";

export interface ParsedReport {
  status: "verified" | "failed" | "unsure";
  confidence: Confidence;
  summary: string;
  sections: Record<string, string>;
}

const REPORT_HEADERS = [
  "What did you verify?",
  "What could you not verify?",
  "What feedback did you give?",
  "What do you need from me to verify this next time?",
  "Verification metadata",
] as const;

/**
 * Pull the `## Report` block out of the assistant's last message and split
 * it into its known H3 sections. Returns null if the block is missing or
 * the STATUS line can't be parsed — both of which the caller treats as
 * "no report this cycle".
 *
 * `turnIndex` is used only for the fallback summary when no verified section
 * is present.
 */
export function parseReport(raw: string, turnIndex: number): ParsedReport | null {
  const reportIdx = raw.search(/^##\s+Report\s*$/m);
  if (reportIdx === -1) return null;
  const reportBody = raw.slice(reportIdx);

  // STATUS line — case-insensitive, anywhere on its own line in the block.
  const statusMatch = reportBody.match(/^\s*STATUS\s*:\s*(verified|failed|unsure)\b/im);
  if (!statusMatch) return null;
  const status = statusMatch[1]!.toLowerCase() as ParsedReport["status"];

  // CONFIDENCE line — case-insensitive, optional. If the agent omits it,
  // derive a sensible default from STATUS so the bar still gets a meaningful
  // color:
  //   verified → "verified" (green)
  //   failed   → "feedback" (orange) — STATUS:failed implies the verifier
  //              identified a problem and ideally called verifier_prompt
  //   unsure   → "failed"   (red)    — the verifier itself couldn't judge
  const confMatch = reportBody.match(
    /^\s*CONFIDENCE\s*:\s*(perfect|verified|partial|feedback|failed)\b/im,
  );
  const confidence: Confidence = confMatch
    ? (confMatch[1]!.toLowerCase() as Confidence)
    : status === "verified"
      ? "verified"
      : status === "failed"
        ? "feedback"
        : "failed";

  // Split the body on H3 boundaries to populate sections.
  const sections: Record<string, string> = {};
  for (const header of REPORT_HEADERS) {
    const re = new RegExp(
      `^###\\s+${escapeRegex(header)}\\s*$([\\s\\S]*?)(?=^###\\s|^##\\s|(?![\\s\\S]))`,
      "m",
    );
    const m = reportBody.match(re);
    if (m && m[1]) {
      sections[header] = m[1].trim();
    }
  }

  // Summary — first non-empty line of "What did you verify?" or fallback.
  const verifiedSection = sections["What did you verify?"];
  let summary: string;
  if (verifiedSection) {
    const firstLine = verifiedSection.split("\n").find((l) => l.trim().length > 0);
    summary = (firstLine ?? "").trim();
  } else {
    summary = "";
  }
  if (!summary) {
    summary = `${status} for turn ${turnIndex}`;
  }

  return { status, confidence, summary, sections };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull the concatenated text content out of an assistant message. We only
 * care about TextContent blocks — thinking and tool calls aren't part of
 * the user-facing "## Report" surface.
 */
export function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}
