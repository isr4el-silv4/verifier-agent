import { describe, it, expect } from "@jest/globals";
import { resolveScopedModelsFromPatterns, extractThinking } from "../_shared/scoped-models";

/**
 * Fake Model<any> compatible with the resolver.
 * Only the fields used by pattern matching are required here.
 */
function fakeModel(provider: string, id: string, name?: string): any {
  return {
    provider,
    id,
    name: name ?? id,
    api: "messages",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 4096,
  };
}

// ── extractThinking ──────────────────────────────────────────────────────────

describe("extractThinking", () => {
  it("returns pattern unchanged when no colon suffix", () => {
    expect(extractThinking("anthropic/claude-sonnet")).toEqual([
      "anthropic/claude-sonnet",
      undefined,
    ]);
  });

  it("extracts valid thinking level suffix", () => {
    expect(extractThinking("anthropic/claude-sonnet:high")).toEqual([
      "anthropic/claude-sonnet",
      "high",
    ]);
  });

  it("ignores non-thinking suffix after colon", () => {
    expect(extractThinking("openrouter/google/gemini:exacto")).toEqual([
      "openrouter/google/gemini:exacto",
      undefined,
    ]);
  });

  it("handles all valid thinking levels", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
      const [pattern, tl] = extractThinking(`provider/model:${level}`);
      expect(pattern).toBe("provider/model");
      expect(tl).toBe(level);
    }
  });

  it("handles pattern with multiple colons (OpenRouter exacto style)", () => {
    // "openrouter/openai/gpt:exacto:high" → suffix "high" is thinking, rest is pattern
    const [pattern, tl] = extractThinking("openrouter/openai/gpt:exacto:high");
    expect(pattern).toBe("openrouter/openai/gpt:exacto");
    expect(tl).toBe("high");
  });
});

// ── resolveScopedModelsFromPatterns ──────────────────────────────────────────

describe("resolveScopedModelsFromPatterns", () => {
  const allModels = [
    fakeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
    fakeModel("anthropic", "claude-sonnet-4-5-20250929", "Claude Sonnet 4.5 (dated)"),
    fakeModel("anthropic", "claude-opus-4-5", "Claude Opus 4.5"),
    fakeModel("openai", "gpt-5", "GPT-5"),
    fakeModel("openai", "gpt-5-20250929", "GPT-5 (dated)"),
    fakeModel("openai", "o1", "o1"),
    fakeModel("google", "gemini-2.5-pro", "Gemini Pro 2.5"),
    fakeModel("google", "gemini-2.5-flash", "Gemini Flash 2.5"),
  ];

  it("returns empty array when patterns is empty", () => {
    expect(resolveScopedModelsFromPatterns([], allModels)).toEqual([]);
  });

  it("returns empty array when available is empty", () => {
    expect(resolveScopedModelsFromPatterns(["gpt-5"], [])).toEqual([]);
  });

  // ── exact matches ────────────────────────────────────────────────────────

  it("resolves exact provider/id reference", () => {
    const result = resolveScopedModelsFromPatterns(["openai/gpt-5"], allModels);
    expect(result).toHaveLength(1);
    expect(result[0]!.model.provider).toBe("openai");
    expect(result[0]!.model.id).toBe("gpt-5");
  });

  it("resolves exact bare id when unique", () => {
    const result = resolveScopedModelsFromPatterns(["o1"], allModels);
    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("o1");
  });

  // ── thinking level suffix ────────────────────────────────────────────────

  it("preserves thinking level from suffix", () => {
    const result = resolveScopedModelsFromPatterns(
      ["anthropic/claude-sonnet-4-5:high"],
      allModels,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("claude-sonnet-4-5");
    expect(result[0]!.thinkingLevel).toBe("high");
  });

  it("ignores non-thinking suffix (treated as part of pattern)", () => {
    // ":exacto" is not a valid thinking level, so "openrouter/model:exacto" is
    // the whole pattern, which won't match anything here.
    const result = resolveScopedModelsFromPatterns(
      ["openrouter/model:exacto"],
      allModels,
    );
    expect(result).toHaveLength(0);
  });

  // ── glob patterns ────────────────────────────────────────────────────────

  it("resolves glob against provider/id format", () => {
    const result = resolveScopedModelsFromPatterns(
      ["anthropic/*sonnet*"],
      allModels,
    );
    const ids = result.map((r) => r.model.id);
    expect(ids).toContain("claude-sonnet-4-5");
    expect(ids).toContain("claude-sonnet-4-5-20250929");
  });

  it("resolves bare-id glob (without provider prefix)", () => {
    const result = resolveScopedModelsFromPatterns(
      ["gemini*"],
      allModels,
    );
    const ids = result.map((r) => r.model.id);
    expect(ids).toContain("gemini-2.5-pro");
    expect(ids).toContain("gemini-2.5-flash");
  });

  it("propagates thinking level on glob matches", () => {
    const result = resolveScopedModelsFromPatterns(
      ["google/gemini*flash*:low"],
      allModels,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("gemini-2.5-flash");
    expect(result[0]!.thinkingLevel).toBe("low");
  });

  // ── substring matches ────────────────────────────────────────────────────

  it("resolves substring match when not exact or glob", () => {
    // "sonnet" is a substring of the sonnet model ids
    const result = resolveScopedModelsFromPatterns(["sonnet"], allModels);
    // Should group by provider + base id and pick best (alias over dated)
    const ids = result.map((r) => r.model.id);
    expect(ids).toContain("claude-sonnet-4-5");
    // The dated version should be de-duped in favour of the alias
    expect(ids).not.toContain("claude-sonnet-4-5-20250929");
  });

  it("picks alias over dated version in substring grouping", () => {
    const result = resolveScopedModelsFromPatterns(["gpt-5"], allModels);
    // "gpt-5" matches exactly (exact bare id match), not substring path
    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("gpt-5");
  });

  // ── deduplication ────────────────────────────────────────────────────────

  it("deduplicates models matched by multiple patterns", () => {
    const result = resolveScopedModelsFromPatterns(
      ["openai/gpt-5", "openai/gpt-5"],
      allModels,
    );
    expect(result).toHaveLength(1);
  });

  it("deduplicates across exact + glob patterns", () => {
    const result = resolveScopedModelsFromPatterns(
      ["openai/gpt-5", "openai/*"],
      allModels,
    );
    // openai/* matches gpt-5, gpt-5-20250929, o1; gpt-5 was already added
    expect(result.map((r) => r.model.id).sort()).toEqual([
      "gpt-5",
      "gpt-5-20250929",
      "o1",
    ]);
  });

  // ── no matches ───────────────────────────────────────────────────────────

  it("skips patterns that match nothing", () => {
    const result = resolveScopedModelsFromPatterns(
      ["nonexistent/model", "openai/gpt-5"],
      allModels,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.model.id).toBe("gpt-5");
  });
});
