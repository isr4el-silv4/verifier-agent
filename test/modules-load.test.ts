import { describe, it, expect } from "@jest/globals";
import verifierExtension from "../verifier";
import { BuilderInputEditor } from "../verifiable-footer";

/**
 * Smoke tests: the integration-glue modules must register their surface
 * (flags, command, tool, message renderer) against a fake pi API without
 * throwing. These don't exercise sockets/tmux — those are covered by the
 * integration checklist — but they catch wiring regressions (bad imports,
 * typos in pi.register* calls) that pure-unit tests of _shared/* can't.
 */

function makeFakePi(): { api: any; calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {};
  const api: any = {
    flags: new Map<string, boolean | string>(),
    tools: [] as any[],
    commands: new Map<string, any>(),
    renderers: new Map<string, any>(),
    handlers: new Map<string, any[]>(),
    on(event: string, h: any) {
      (this.handlers.get(event) ?? this.handlers.set(event, []).get(event)!).push(h);
    },
    registerFlag(name: string, _opts: any) {
      (calls.registerFlag ??= []).push(name);
      this.flags.set(name, false);
    },
    getFlag(_name: string) {
      return undefined;
    },
    registerTool(t: any) {
      (calls.registerTool ??= []).push(t.name);
      this.tools.push(t);
    },
    registerCommand(name: string, _opts: any) {
      (calls.registerCommand ??= []).push(name);
    },
    registerMessageRenderer(t: string, _r: any) {
      (calls.registerMessageRenderer ??= []).push(t);
    },
    sendMessage() {},
    sendUserMessage() {},
  };
  return { api, calls };
}

describe("verifier.ts (child) module wiring", () => {
  it("registers flags, verifier_prompt tool, builder-event renderer, input lock", () => {
    expect(typeof verifierExtension).toBe("function");
    const { api, calls } = makeFakePi();
    verifierExtension(api);
    expect(calls.registerFlag).toEqual(
      expect.arrayContaining(["child", "builder-session", "agent"]),
    );
    expect(calls.registerTool).toContain("verifier_prompt");
    expect(calls.registerMessageRenderer).toContain("builder-event");
    // Defense-in-depth input lock handler is installed.
    expect(api.handlers.get("input")?.length).toBeGreaterThanOrEqual(1);
  });
});

describe("verifiable-footer.ts module wiring", () => {
  it("exports BuilderInputEditor", () => {
    expect(typeof BuilderInputEditor).toBe("function");
  });
});

import verifiableIndex from "../index";

function makeCommandPi(): { api: any; calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {};
  const api: any = {
    flags: new Map<string, boolean | string>(),
    handlers: new Map<string, any[]>(),
    on(event: string, h: any) {
      (this.handlers.get(event) ?? this.handlers.set(event, []).get(event)!).push(h);
    },
    registerFlag(name: string) {
      (calls.registerFlag ??= []).push(name);
    },
    registerCommand(name: string, opts: any) {
      (calls.registerCommand ??= []).push(name);
      this.commands = this.commands ?? new Map();
      this.commands.set(name, opts);
    },
    registerTool() {},
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  return { api, calls };
}

describe("index.ts (builder) module wiring", () => {
  it("registers /verify command and lifecycle handlers, but NO flags", () => {
    expect(typeof verifiableIndex).toBe("function");
    const { api, calls } = makeCommandPi();
    verifiableIndex(api);
    expect(calls.registerCommand).toContain("verify");
    expect(calls.registerFlag ?? []).toEqual([]); // auto-spawn flags removed
    for (const evt of [
      "session_start",
      "input",
      "before_agent_start",
      "agent_end",
      "session_shutdown",
    ]) {
      expect(api.handlers.get(evt)?.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("/verify handler runs the model wizard and rejects when no models", async () => {
    const { api, calls } = makeCommandPi();
    verifiableIndex(api);
    const verify = api.commands.get("verify");

    const notifications: any[] = [];
    const ctx: any = {
      modelRegistry: { getAvailable: () => [] },
      ui: { select: async () => undefined, notify: (m: string, l: string) => notifications.push({ m, l }) },
    };
    await verify.handler("", ctx);
    expect(notifications.some((n) => /No models available/.test(n.m))).toBe(true);
  });

  it("/verify handler cancels cleanly when the wizard is dismissed", async () => {
    const { api } = makeCommandPi();
    verifiableIndex(api);
    const verify = api.commands.get("verify");

    const notifications: any[] = [];
    const ctx: any = {
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai", id: "gpt-5.5" },
          { provider: "anthropic", id: "claude-x" },
        ],
      },
      ui: { select: async () => undefined, notify: (m: string) => notifications.push(m) },
    };
    await verify.handler("", ctx);
    expect(notifications.some((m) => /Cancelled/.test(m))).toBe(true);
  });
});

describe("index.ts (builder) does NOT activate in the verifier child", () => {
  // The global entry auto-loads in the child too. When spawned with `--child`,
  // it must register NOTHING — otherwise its session_start installs the
  // interactive BuilderInputEditor and clobbers the child's locked
  // VerifierStatusBar (the "child window is still interactive" bug).
  it("registers no commands/handlers when --child is on the process argv", () => {
    const { api, calls } = makeCommandPi();
    const savedArgv = process.argv;
    process.argv = ["node", "pi", "-e", "verifier.ts", "--child", "--builder-session", "s"];
    try {
      verifiableIndex(api);
    } finally {
      process.argv = savedArgv;
    }
    expect(calls.registerCommand ?? []).toEqual([]);
    for (const evt of ["session_start", "before_agent_start", "agent_end", "input", "session_shutdown"]) {
      expect(api.handlers.get(evt)?.length ?? 0).toBe(0);
    }
  });

  it("still registers /verify when NOT in child mode", () => {
    const { api, calls } = makeCommandPi();
    const savedArgv = process.argv;
    process.argv = ["node", "pi"];
    try {
      verifiableIndex(api);
    } finally {
      process.argv = savedArgv;
    }
    expect(calls.registerCommand).toContain("verify");
  });
});

describe("/verify model selection wizard", () => {
  it("shows small model list directly (no filter prompt)", async () => {
    const { api } = makeCommandPi();
    verifiableIndex(api);
    const verify = api.commands.get("verify");

    const notifications: any[] = [];
    const selectCalls: any[] = [];
    let inputCalled = false;

    const ctx: any = {
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai", id: "gpt-4.1" },
          { provider: "anthropic", id: "claude-sonnet-4-6" },
        ],
      },
      ui: {
        select: async (title: string, opts: string[]) => {
          selectCalls.push({ title, opts });
          return "openai/gpt-4.1";
        },
        input: async () => {
          inputCalled = true;
          return undefined;
        },
        notify: (m: string) => notifications.push(m),
      },
      sessionManager: {
        getSessionId: () => "test-session-id",
        getSessionFile: () => "/tmp/test.jsonl",
      },
      cwd: "/tmp/test",
    };
    await verify.handler("", ctx);
    // Should NOT have called input() since list is small
    expect(inputCalled).toBe(false);
    // Should show both models directly
    expect(selectCalls[0].opts).toEqual([
      "openai/gpt-4.1",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("prompts for filter when model list exceeds threshold", async () => {
    const { api } = makeCommandPi();
    verifiableIndex(api);
    const verify = api.commands.get("verify");

    const selectCalls: any[] = [];
    const manyModels = Array.from({ length: 30 }, (_, i) => ({
      provider: i % 2 === 0 ? "openai" : "anthropic",
      id: `model-${i}`,
    }));

    const ctx: any = {
      modelRegistry: { getAvailable: () => manyModels },
      ui: {
        select: async (title: string, opts: string[]) => {
          selectCalls.push({ title, opts });
          return opts[0]; // pick first
        },
        input: async () => "open", // user types "open" as filter
        notify: () => {},
      },
      sessionManager: {
        getSessionId: () => "test-session-id",
        getSessionFile: () => "/tmp/test.jsonl",
      },
      cwd: "/tmp/test",
    };
    await verify.handler("", ctx);

    // The shown options should be filtered to only "openai" models
    const shownOpts = selectCalls[0].opts;
    for (const opt of shownOpts) {
      expect(opt.toLowerCase()).toContain("openai");
    }
  });

  it("cancels gracefully when filter input is dismissed", async () => {
    const { api } = makeCommandPi();
    verifiableIndex(api);
    const verify = api.commands.get("verify");

    const notifications: any[] = [];
    let selectReached = false;
    const manyModels = Array.from({ length: 30 }, (_, i) => ({
      provider: "openai",
      id: `gpt-${i}`,
    }));

    const ctx: any = {
      modelRegistry: { getAvailable: () => manyModels },
      ui: {
        select: async () => {
          selectReached = true;
        },
        input: async () => undefined, // cancel immediately
        notify: (m: string) => notifications.push(m),
      },
    };
    await verify.handler("", ctx);
    expect(selectReached).toBe(false);
    expect(notifications.some((m) => /Cancelled/i.test(m))).toBe(true);
  });

  it("empty filter shows all models", async () => {
    const { api } = makeCommandPi();
    verifiableIndex(api);
    const verify = api.commands.get("verify");

    const selectCalls: any[] = [];
    const manyModels = Array.from({ length: 30 }, (_, i) => ({
      provider: i % 2 === 0 ? "openai" : "anthropic",
      id: `model-${i}`,
    }));

    const ctx: any = {
      modelRegistry: { getAvailable: () => manyModels },
      ui: {
        select: async (title: string, opts: string[]) => {
          selectCalls.push({ title, opts });
          return opts[0];
        },
        input: async () => "", // empty filter
        notify: () => {},
      },
      sessionManager: { getSessionId: () => "test-session-3", getSessionFile: () => null },
      cwd: "/tmp/test",
    };
    await verify.handler("", ctx);

    // Empty filter should show ALL models
    const shownOpts = selectCalls[0].opts;
    expect(shownOpts.length).toBe(manyModels.length);
  });

  it("re-prompts when filter matches nothing", async () => {
    const { api } = makeCommandPi();
    verifiableIndex(api);
    const verify = api.commands.get("verify");

    const notifications: any[] = [];
    const inputCallLog: string[] = [];
    const manyModels = Array.from({ length: 25 }, (_, i) => ({
      provider: "openai",
      id: `gpt-${i}`,
    }));

    const ctx: any = {
      modelRegistry: { getAvailable: () => manyModels },
      ui: {
        select: async (title: string, opts: string[]) => opts[0],
        input: async (_: string, placeholder: string) => {
          inputCallLog.push(placeholder);
          if (inputCallLog.length === 1) return "nonexistent"; // first: bad filter
          if (inputCallLog.length === 2) return "gpt-1";       // second: valid
          return undefined;
        },
        notify: (m: string) => notifications.push(m),
      },
      sessionManager: { getSessionId: () => "test-session-4", getSessionFile: () => null },
      cwd: "/tmp/test",
    };
    await verify.handler("", ctx);

    // Should have warned about no matches and re-prompted
    expect(notifications.some((n) => /No models match/i.test(n))).toBe(true);
    expect(inputCallLog.length).toBeGreaterThanOrEqual(2);
  });
});
