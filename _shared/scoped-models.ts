/**
 * Resolve the user's scoped-models list (the `enabledModels` patterns from
 * their pi settings) against the models currently available in the registry.
 *
 * Supports exact IDs, provider/model references, glob patterns, and optional
 * `:<thinkingLevel>` suffixes (e.g. "anthropic/*sonnet*:high").
 *
 * Returns an empty array when no patterns are configured — the
 * `ModelSelectorComponent` automatically falls back to "all" scope in that
 * case, which is the same behaviour as pi's built-in `/model` selector.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";

export interface ScopedModelResult {
  model: Model<any>;
  thinkingLevel?: string;
}

const VALID_THINKING_LEVELS = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

const keyFor = (m: Model<any>) => `${m.provider}/${m.id}`;

/**
 * Pick the "best" representative among candidate models sharing a
 * provider + base-id: prefer the alias (no date suffix) over dated variants,
 * and among dated variants prefer the most recent one.
 */
function pickBest<T extends Model<any>>(candidates: T[]): T | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, c) => {
    if (c.id.length < best.id.length) return c;
    if (c.id.length > best.id.length) return best;
    return c.id > best.id ? c : best;
  });
}

/**
 * Strip a trailing `:<thinkingLevel>` suffix.
 * Returns [pattern, level?].
 */
export function extractThinking(raw: string): [string, string | undefined] {
  const colon = raw.lastIndexOf(":");
  if (colon === -1) return [raw, undefined];
  const suffix = raw.substring(colon + 1);
  if (!VALID_THINKING_LEVELS.has(suffix)) return [raw, undefined];
  return [raw.substring(0, colon), suffix];
}

/**
 * Testable core — resolve patterns against a known model list.
 *
 * Exported for unit tests; consumers should use {@link resolveScopedModelsFromCwd}
 * which reads patterns from settings automatically.
 */
export function resolveScopedModelsFromPatterns(
  patterns: string[],
  available: Model<any>[],
): ScopedModelResult[] {
  if (!patterns || patterns.length === 0) return [];
  if (available.length === 0) return [];

  const result: ScopedModelResult[] = [];
  const seen = new Set<string>();

  for (const rawPattern of patterns) {
    const [pattern, thinkingLevel] = extractThinking(rawPattern);
    const hasGlob = /[*?[\]]/.test(pattern);

    if (hasGlob) {
      const matches = available.filter((m) =>
        minimatch(`${m.provider}/${m.id}`, pattern, { nocase: true }) ||
        minimatch(m.id, pattern, { nocase: true }),
      );
      for (const m of matches) {
        const k = keyFor(m);
        if (!seen.has(k)) {
          seen.add(k);
          result.push({ model: m, thinkingLevel });
        }
      }
      continue;
    }

    // Non-glob: exact match first (provider/id or bare id), then substring.
    const exactByFullId = available.find((m) => `${m.provider}/${m.id}` === pattern);
    if (exactByFullId) {
      const k = keyFor(exactByFullId);
      if (!seen.has(k)) {
        seen.add(k);
        result.push({ model: exactByFullId, thinkingLevel });
      }
      continue;
    }

    const exactByBareId = available.filter((m) => m.id === pattern);
    if (exactByBareId.length === 1) {
      const m = exactByBareId[0]!;
      const k = keyFor(m);
      if (!seen.has(k)) {
        seen.add(k);
        result.push({ model: m, thinkingLevel });
      }
      continue;
    }

    // Substring: find all models whose id or provider/id contains the pattern,
    // then keep only the "best" version per logical model.
    const substringMatches = available.filter(
      (m) =>
        m.id.includes(pattern) ||
        `${m.provider}/${m.id}`.includes(pattern),
    );

    const groups = new Map<string, typeof available>();
    for (const m of substringMatches) {
      const baseId = m.id.replace(/-\d{6,8}$/, "");
      const gk = `${m.provider}/${baseId}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk)!.push(m);
    }

    for (const candidates of groups.values()) {
      const best = pickBest(candidates);
      if (!best) continue;
      const k = keyFor(best);
      if (!seen.has(k)) {
        seen.add(k);
        result.push({ model: best, thinkingLevel });
      }
    }
  }

  return result;
}

/**
 * Main entry point: reads `enabledModels` from the user's pi settings and
 * resolves the patterns against the registry's currently available models.
 */
export async function resolveScopedModelsFromCwd(
  cwd: string,
  modelRegistry: ModelRegistry,
): Promise<ScopedModelResult[]> {
  let settingsMgr: SettingsManager;
  try {
    settingsMgr = SettingsManager.create(cwd, getAgentDir());
  } catch {
    return [];
  }

  const patterns = settingsMgr.getEnabledModels();
  if (!patterns || patterns.length === 0) return [];

  const available = modelRegistry.getAvailable();
  return resolveScopedModelsFromPatterns(patterns, available);
}
