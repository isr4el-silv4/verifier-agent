/**
 * Verifier persona frontmatter parser + body templating.
 *
 * Adapted from the original the-verifier-agent to the user's YAML persona
 * format (the same format as `~/.pi/agent/personas/*.yaml`). Key differences
 * from the original:
 *
 *   - REMOVED: `model`  (the model is now chosen via the `/verify` wizard and
 *     passed to the child explicitly — no longer a persona frontmatter field).
 *   - REMOVED: `domain` (generic-only v1; the `<DOMAIN>` template var is gone).
 *   - ADDED:   `systemPromptMode`, `inheritProjectContext`, `interactive`
 *     (pi-native fields, mirroring `builder.yaml` / `researcher.yaml`).
 *   - KEPT:    `max_loops` (optional, default 3 applied by the caller).
 *
 * Wraps `parseFrontmatter` from `@earendil-works/pi-coding-agent`, layering
 * verifier-specific shape validation on top. Templating is deliberately the
 * dumbest possible thing — global string replace on `<UPPER_SNAKE>` slots.
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VerifierFrontmatter {
  name: string;
  description: string;
  /** Comma-separated tool list, parsed downstream by the launcher/verifier. */
  tools: string;
  /** "replace" | "append" — pi-native field. */
  systemPromptMode: string;
  inheritProjectContext: boolean;
  interactive: boolean;
  /** Optional per-cycle correction cap (default 3, applied by callers). */
  max_loops?: number;
}

export interface ParsedVerifierPersona {
  frontmatter: VerifierFrontmatter;
  body: string;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a `verifier.yaml` persona file into typed frontmatter + raw body.
 * Throws with a clear, field-naming message on any missing required field —
 * these are user-authored files, so the error needs to point a human at
 * exactly what's wrong.
 *
 * Note: we do NOT validate `tools` content (e.g. "is `bash` actually a known
 * pi tool name") here — that's the launcher's job at spawn time, where it has
 * access to the pi runtime tool registry.
 */
export function parseVerifierPersona(content: string): ParsedVerifierPersona {
  const { frontmatter: raw, body } = parseFrontmatter<Record<string, unknown>>(content);

  // Required scalars.
  const name = requireString(raw, "name");
  const description = requireString(raw, "description");
  const tools = requireString(raw, "tools");
  const systemPromptMode = requireString(raw, "systemPromptMode");

  // Required booleans (pi-native).
  const inheritProjectContext = requireBool(raw, "inheritProjectContext");
  const interactive = requireBool(raw, "interactive");

  // Optional fields.
  const max_loops = optionalNumber(raw, "max_loops");

  const frontmatter: VerifierFrontmatter = {
    name,
    description,
    tools,
    systemPromptMode,
    inheritProjectContext,
    interactive,
    ...(max_loops !== undefined ? { max_loops } : {}),
  };

  return { frontmatter, body };
}

// ─── Templating ──────────────────────────────────────────────────────────────

/**
 * Replace `<UPPER_SNAKE_CASE>` placeholders in `body` with values from
 * `vars`. Pure string replacement, global, case-sensitive.
 *
 * Keys in `vars` should be the placeholder name without the angle
 * brackets (e.g. `BUILDER_SESSION_ID`, not `<BUILDER_SESSION_ID>`).
 *
 * Placeholders that don't appear in `vars` are left untouched. This is
 * intentional: the body is templated in two stages (system-prompt vars
 * at spawn, user-prompt vars per cycle); the first stage shouldn't fail
 * on slots the second stage will fill.
 */
export function templateBody(body: string, vars: Record<string, string>): string {
  let out = body;
  for (const key of Object.keys(vars)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(
        `templateBody: variable name "${key}" must be UPPER_SNAKE_CASE (matches /^[A-Z][A-Z0-9_]*$/).`,
      );
    }
    const pattern = new RegExp(`<${key}>`, "g");
    out = out.replace(pattern, vars[key]!);
  }
  return out;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function requireString(obj: Record<string, unknown>, fieldPath: string): string {
  const v = lookup(obj, fieldPath);
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `Verifier persona frontmatter: required field "${fieldPath}" is missing or not a non-empty string.`,
    );
  }
  return v;
}

function requireBool(obj: Record<string, unknown>, fieldPath: string): boolean {
  const v = lookup(obj, fieldPath);
  if (typeof v !== "boolean") {
    throw new Error(
      `Verifier persona frontmatter: required field "${fieldPath}" must be a boolean (true/false). Got: ${JSON.stringify(v)}.`,
    );
  }
  return v;
}

function optionalNumber(obj: Record<string, unknown>, fieldPath: string): number | undefined {
  const v = lookup(obj, fieldPath);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(
      `Verifier persona frontmatter: optional field "${fieldPath}" must be a finite number if present. Got: ${JSON.stringify(v)}.`,
    );
  }
  return v;
}

/**
 * Tiny dotted-path lookup so we can address nested fields with the same
 * error-message machinery as top-level scalars. Only used by the `require*`
 * helpers, never user-facing.
 */
function lookup(obj: Record<string, unknown>, fieldPath: string): unknown {
  const parts = fieldPath.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
