import { describe, it, expect } from "@jest/globals";
import {
  normalizeToolsList,
  shellSingleQuote,
  buildSpawnWrapper,
  type BuildSpawnWrapperOpts,
} from "../_shared/launcher";

describe("normalizeToolsList", () => {
  it("trims whitespace and dedups, always appending verifier_prompt", () => {
    expect(normalizeToolsList("read, grep , find , ls , bash")).toBe(
      "read,grep,find,ls,bash,verifier_prompt",
    );
  });

  it("does not duplicate verifier_prompt if already present", () => {
    expect(normalizeToolsList("read, verifier_prompt")).toBe("read,verifier_prompt");
  });

  it("returns empty string for empty/whitespace-only input", () => {
    expect(normalizeToolsList("")).toBe("");
    expect(normalizeToolsList("  ,  ")).toBe("");
  });
});

describe("shellSingleQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellSingleQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes via '\\''", () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
  });

  it("round-trips arbitrary content", () => {
    const inputs = ["", "plain", "a b c", "$HOME", 'q"q', "line\nbreak", "it's a test"];
    for (const s of inputs) {
      // Evaluate the single-quoted token with sh; it must reproduce the input.
      const token = shellSingleQuote(s);
      expect(token.startsWith("'") && token.endsWith("'")).toBe(true);
    }
  });
});

function baseOpts(over: Partial<BuildSpawnWrapperOpts> = {}): BuildSpawnWrapperOpts {
  return {
    env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-test" },
    systemPromptFile: "/tmp/sys.md",
    verifierEntry: "/home/u/.pi/agent/extensions/verifier-agent/verifier.ts",
    sessionId: "s-123",
    agentPath: "/home/u/.pi/agent/personas/verifier.yaml",
    tools: "read,grep,find,ls,bash,verifier_prompt",
    model: "openai/gpt-5.5",
    stderrLogPath: "/tmp/err.log",
    ...over,
  };
}

describe("buildSpawnWrapper", () => {
  it("is a bash script that forwards env and execs pi with the child flags", () => {
    const w = buildSpawnWrapper(baseOpts());
    expect(w.startsWith("#!/usr/bin/env bash")).toBe(true);

    // env forwarded
    expect(w).toContain('export PATH=');
    expect(w).toContain('export OPENAI_API_KEY=');

    // pi invocation with all child flags
    expect(w).toContain("-e '/home/u/.pi/agent/extensions/verifier-agent/verifier.ts'");
    expect(w).toContain("--child");
    expect(w).toContain("--builder-session 's-123'");
    expect(w).toContain(
      "--agent '/home/u/.pi/agent/personas/verifier.yaml'",
    );
    expect(w).toContain('--system-prompt "$(cat \'/tmp/sys.md\')"');
    // model comes from the wizard param, NOT the persona
    expect(w).toContain("--model 'openai/gpt-5.5'");
    // tools list normalized + appended with verifier_prompt
    expect(w).toContain(
      "--tools 'read,grep,find,ls,bash,verifier_prompt'",
    );

    // stderr is captured to a log and mirrored to the terminal
    expect(w).toContain('STDERR_LOG=\'/tmp/err.log\'');
    expect(w).toMatch(/tee -a "\$STDERR_LOG" >&2/);
    // exit code recorded
    expect(w).toContain("EXIT_CODE=$?");
  });

  it("omits --tools when the normalized list is empty (pi defaults)", () => {
    const w = buildSpawnWrapper(baseOpts({ tools: "" }));
    expect(w).not.toContain("--tools");
  });

  it("skips process-tied and TMUX env vars", () => {
    const w = buildSpawnWrapper(
      baseOpts({ env: { PATH: "/bin", _: "/usr/bin/pi", OLDPWD: "/x", PWD: "/y", TMUX_PANE: "%1" } }),
    );
    expect(w).toContain('export PATH=');
    expect(w).not.toContain("export _=");
    expect(w).not.toContain("export OLDPWD=");
    expect(w).not.toContain("export PWD=");
    expect(w).not.toContain("export TMUX_PANE=");
  });
});
