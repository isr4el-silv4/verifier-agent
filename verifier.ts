/**
 * Pi Verifier Agent — verifier-side extension.
 *
 * Loaded into the *child* Pi instance that runs inside the tmux window the
 * launcher created. Invoked by Pi at startup with:
 *   pi -e <extensionRoot>/verifier.ts \
 *     --child --builder-session <sid> --agent <path> \
 *     --system-prompt <rendered> --model <wizard-model>
 *
 * Adapted from the original the-verifier-agent:
 *   - imports updated to @earendil-works/* packages
 *   - the verify_on_stop.md prompt template is resolved relative to this
 *     extension directory (not the project cwd)
 *   - report parsing + assistant-text extraction are imported from
 *     `./_shared/report` (extracted for unit testing)
 *   - persona name derivation strips `.yaml`
 */

import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { loadDotEnv } from "./_shared/env";
import { parseVerifierPersona, templateBody } from "./_shared/frontmatter";
import {
  assertDirection,
  encodeEnvelope,
  readEnvelopes,
  type Confidence,
  type Envelope,
  type Event as BuilderEvent,
  type Hello,
  type Ping,
  type Pong,
  type Prompt,
  type PromptAck,
  type Report,
} from "./_shared/ipc";
import { parseReport, extractAssistantText, type ParsedReport } from "./_shared/report";
import { resolveSocketPath } from "./_shared/socket-path";

// ─── Module state ────────────────────────────────────────────────────────────

type Phase =
  | "connecting"
  | "connected"
  | "verifying"
  | "verified"
  | "failed"
  | "unsure"
  | "error"
  | "disconnected";

interface VerifierState {
  phase: Phase;
  builderSessionId: string;
  socketPath: string;
  parentConn: net.Socket | null;
  agentPath: string;
  /** Persona display name (basename of agentPath, no extension, UPPERCASE). */
  personaName: string;
  maxLoops: number;
  currentTurnIndex: number;
  /** Last error detail surfaced from a builder `event { name: "error" }`. */
  errorDetail: string;
  /** ms epoch of last inbound traffic — drives "last ack <n>ms ago" footer. */
  lastAckTimestamp: number;
  pingInterval: NodeJS.Timeout | null;
  pendingPongs: number;
  pendingPromptAcks: Map<string, (ack: PromptAck) => void>;
  /** True if `verifier_prompt` was called during the current verification cycle. */
  promptedThisCycle: boolean;
  /**
   * Confidence grade from the most recent Report. Drives the status-bar
   * background color (green / orange / red). `null` = no Report yet.
   */
  confidence: Confidence | null;
  /** Reference to the live UI ctx so the status bar can re-render on phase changes. */
  uiCtx: ExtensionContext | null;
  /** Set once the `connecting` → `connected` transition has been observed. */
  helloAcked: boolean;
  /** Suppress cleanup re-entry on shutdown. */
  shuttingDown: boolean;
}

const state: VerifierState = {
  phase: "connecting",
  builderSessionId: "",
  socketPath: "",
  parentConn: null,
  agentPath: "",
  personaName: "",
  maxLoops: 3,
  currentTurnIndex: 0,
  errorDetail: "",
  lastAckTimestamp: 0,
  pingInterval: null,
  pendingPongs: 0,
  pendingPromptAcks: new Map(),
  promptedThisCycle: false,
  confidence: null,
  uiCtx: null,
  helloAcked: false,
  shuttingDown: false,
};

// ─── Status-bar helpers ──────────────────────────────────────────────────────

function truncateAscii(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return text.slice(0, width - 1) + "…";
}

function fullWidthAsciiBar(width: number, left: string, center: string, right: string): string {
  if (width <= 0) return "";
  const minGap = " ";
  const fixedRight = right;
  const fixedCenter = center;

  let availableForLeft = width - fixedCenter.length - fixedRight.length - minGap.length * 2;
  if (availableForLeft < 0) availableForLeft = 0;

  const safeLeft = truncateAscii(left, availableForLeft);
  let raw = safeLeft + minGap + fixedCenter + minGap + fixedRight;

  if (raw.length > width) raw = truncateAscii(raw, width);
  if (raw.length < width) raw = raw + " ".repeat(width - raw.length);

  return raw;
}

// ─── Phase formatting ────────────────────────────────────────────────────────

function formatPhase(phase: Phase): string {
  switch (phase) {
    case "connecting":
      return "◌ connecting...";
    case "connected":
      return "● connected to builder";
    case "verifying":
      return "… verifying...";
    case "verified":
      return "✓ verified";
    case "failed":
      return state.promptedThisCycle
        ? "✗ failed · prompted builder"
        : "✗ failed";
    case "unsure":
      return "⚠ unsure";
    case "error":
      return `⚠ builder error: ${truncateAscii(state.errorDetail || "(no detail)", 40)}`;
    case "disconnected":
      return "✗ socket dropped — exiting in 5s";
  }
}

function bgForConfidence(confidence: Confidence | null, phase: Phase): string {
  if (phase === "verifying") return "\x1b[48;5;57m"; // purple
  if (phase === "connecting" || phase === "disconnected" || phase === "error") {
    return "\x1b[48;5;57m"; // purple
  }
  switch (confidence) {
    case "perfect":
    case "verified":
      return "\x1b[48;5;28m"; // green
    case "partial":
    case "feedback":
      return "\x1b[48;5;130m"; // orange
    case "failed":
      return "\x1b[48;5;124m"; // red
    default:
      return "\x1b[48;5;57m"; // purple
  }
}

// ─── VerifierStatusBar ───────────────────────────────────────────────────────

class VerifierStatusBar extends CustomEditor {
  override render(width: number): string[] {
    const left = ` ${state.personaName || "VERIFIER"} `;
    const phase = formatPhase(state.phase);
    const conf = state.confidence
      ? ` · ${state.confidence.toUpperCase()}`
      : "";
    const center = ` ${phase}${conf} `;
    const right = " ";

    const raw = fullWidthAsciiBar(width, left, center, right);

    const bg = bgForConfidence(state.confidence, state.phase);
    const fgWhite = "\x1b[38;5;231m";
    const bold = "\x1b[1m";
    const reset = "\x1b[0m";

    return [`${bg}${fgWhite}${bold}${raw}${reset}`];
  }

  override handleInput(data: string): void {
    const self = this as unknown as {
      keybindings: { matches(data: string, action: string): boolean };
    };

    if (this.onExtensionShortcut?.(data)) return;

    if (self.keybindings.matches(data, "app.clipboard.pasteImage")) {
      this.onPasteImage?.();
      return;
    }

    if (self.keybindings.matches(data, "app.interrupt")) {
      if (!this.isShowingAutocomplete()) {
        const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
        if (handler) {
          handler();
          return;
        }
      }
      super.handleInput(data);
      return;
    }

    if (self.keybindings.matches(data, "app.exit")) {
      if (this.getText().length === 0) {
        const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
        if (handler) handler();
      }
      return;
    }

    for (const [action, handler] of this.actionHandlers) {
      if (
        action !== "app.interrupt" &&
        action !== "app.exit" &&
        self.keybindings.matches(data, action)
      ) {
        handler();
        return;
      }
    }
    // Swallow all normal typing/Enter/etc. This is not an input field anymore.
  }
}

// ─── Default factory ─────────────────────────────────────────────────────────

export default function verifierExtension(pi: ExtensionAPI): void {
  pi.registerFlag("child", {
    type: "boolean",
    description: "Run as verifier child",
  });
  pi.registerFlag("builder-session", {
    type: "string",
    description: "Builder session ID to attach to",
  });
  pi.registerFlag("agent", {
    type: "string",
    description: "Path to verifier persona file",
  });

  pi.registerMessageRenderer("builder-event", (message, _options, theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("");
    return new Text(theme.fg("muted", content), 0, 0);
  });

  // ── verifier_prompt tool ─────────────────────────────────────────────────
  pi.registerTool({
    name: "verifier_prompt",
    label: "Verifier Prompt",
    description:
      "Send a corrective user-style prompt to the builder agent. Use this to " +
      "request a follow-up action when verification fails. The message is " +
      "delivered to the builder via pi.sendUserMessage.",
    promptSnippet:
      "Send a corrective prompt to the builder when verification fails.",
    parameters: Type.Object({
      session_id: Type.String({
        description:
          "Builder session id (uuid). Use the value from your system Variables; never invent.",
      }),
      message: Type.String({
        description:
          "User-style corrective prompt to inject into the builder. Be specific and actionable.",
      }),
      deliver_as: Type.Optional(
        Type.Union([Type.Literal("followUp"), Type.Literal("steer")]),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!state.parentConn || state.parentConn.destroyed) {
        return {
          content: [
            {
              type: "text",
              text:
                "✗ verifier_prompt rejected: not connected to builder (socket closed). " +
                "Cannot deliver corrective prompt right now.",
            },
          ],
          details: { ok: false, reason: "socket_closed" },
        };
      }

      const correlationId = crypto.randomUUID();
      const envelope: Prompt = {
        type: "prompt",
        sessionId: params.session_id,
        message: params.message,
        deliverAs: params.deliver_as ?? "followUp",
        correlationId,
      };

      const ackPromise = new Promise<PromptAck>((resolve, reject) => {
        const timeout = setTimeout(() => {
          state.pendingPromptAcks.delete(correlationId);
          reject(new Error("prompt_ack timeout (60s) — builder did not respond"));
        }, 60_000);

        state.pendingPromptAcks.set(correlationId, (ack) => {
          clearTimeout(timeout);
          resolve(ack);
        });
      });

      try {
        assertDirection(envelope, "verifier-to-builder");
        state.parentConn.write(encodeEnvelope(envelope));
      } catch (err) {
        state.pendingPromptAcks.delete(correlationId);
        return {
          content: [
            {
              type: "text",
              text: `✗ verifier_prompt failed to send: ${(err as Error).message}`,
            },
          ],
          details: { ok: false, reason: "write_failed", correlationId },
        };
      }

      try {
        const ack = await ackPromise;
        state.promptedThisCycle = true;
        return {
          content: [
            {
              type: "text",
              text: ack.ok
                ? `✓ ack: prompt delivered to builder`
                : `✗ rejected: ${ack.error ?? "(no reason given)"}`,
            },
          ],
          details: { correlationId, ok: ack.ok, error: ack.error },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `✗ verifier_prompt failed: ${(err as Error).message}` },
          ],
          details: { ok: false, reason: "timeout", correlationId },
        };
      }
    },
  });

  // ── Defense-in-depth input lock ──────────────────────────────────────────
  pi.on("input", async (event: InputEvent, ctx): Promise<InputEventResult> => {
    if (event.source === "extension") return { action: "continue" };
    ctx.ui.notify(
      "Verifier input is disabled — driven by builder events only.",
      "warning",
    );
    return { action: "handled" };
  });

  // ── Verifier's own agent_end → emit Report envelope ──────────────────────
  pi.on("agent_end", async (_event: AgentEndEvent, ctx) => {
    if (!state.parentConn || state.parentConn.destroyed) return;

    const entries = ctx.sessionManager.getEntries();
    let raw = "";
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "assistant") continue;
      raw = extractAssistantText(msg.content);
      break;
    }
    if (!raw) {
      state.phase = "error";
      state.errorDetail = "no assistant message";
      requestStatusRender(ctx);
      return;
    }

    const report: ParsedReport | null = parseReport(raw, state.currentTurnIndex);
    if (!report) {
      state.phase = "error";
      state.errorDetail = "report parse failed";
      requestStatusRender(ctx);
      return;
    }

    state.phase =
      report.status === "verified"
        ? "verified"
        : report.status === "failed"
          ? "failed"
          : "unsure";
    state.confidence = report.confidence;
    requestStatusRender(ctx);

    const envelope: Report = {
      type: "report",
      sessionId: state.builderSessionId,
      turnIndex: state.currentTurnIndex,
      status: report.status,
      confidence: report.confidence,
      summary: report.summary,
      sections: report.sections,
      raw,
    };
    try {
      assertDirection(envelope, "verifier-to-builder");
      state.parentConn.write(encodeEnvelope(envelope));
    } catch (err) {
      ctx.ui.notify(
        `verifier: failed to send report envelope: ${(err as Error).message}`,
        "error",
      );
    }
  });

  // ── session_start: validate flags, install editor, connect socket ────────
  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    if (!pi.getFlag("child")) return;

    state.uiCtx = ctx;

    const envResult = await loadDotEnv(ctx.cwd);
    if (!envResult.loaded && envResult.reason) {
      ctx.ui.notify(`verifier: ${envResult.reason}`, "warning");
    }

    const builderSession = pi.getFlag("builder-session");
    const agentPath = pi.getFlag("agent");
    if (typeof builderSession !== "string" || builderSession.length === 0) {
      ctx.ui.notify(
        "verifier: missing required flags --builder-session and --agent",
        "error",
      );
      return;
    }
    if (typeof agentPath !== "string" || agentPath.length === 0) {
      ctx.ui.notify(
        "verifier: missing required flags --builder-session and --agent",
        "error",
      );
      return;
    }
    state.builderSessionId = builderSession;
    state.agentPath = agentPath;
    // Derive display name: basename, strip extension (.yaml or .md), uppercase.
    state.personaName = path
      .basename(agentPath)
      .replace(/\.(ya?ml|md)$/i, "")
      .toUpperCase();

    let maxLoops: number;
    try {
      const personaContent = readFileSync(state.agentPath, "utf-8");
      const persona = parseVerifierPersona(personaContent);
      maxLoops = persona.frontmatter.max_loops ?? 3;
    } catch (err) {
      ctx.ui.notify(
        `verifier: failed to load persona at ${state.agentPath}: ${(err as Error).message}`,
        "error",
      );
      return;
    }
    state.maxLoops = maxLoops;

    if (ctx.hasUI) {
      ctx.ui.setEditorComponent(
        (tui, theme, kb) => new VerifierStatusBar(tui, theme, kb, {}),
      );
      installVerifierFooter(ctx);
    }

    try {
      const { socketPath } = resolveSocketPath(state.builderSessionId, ctx.cwd);
      state.socketPath = socketPath;
    } catch (err) {
      ctx.ui.notify(
        `verifier: socket path resolution failed: ${(err as Error).message}`,
        "error",
      );
      return;
    }

    connectToParent(pi, ctx);
  });

  // ── session_shutdown: clean up socket + editor ───────────────────────────
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx) => {
    if (!pi.getFlag("child")) return;
    state.shuttingDown = true;
    teardown(ctx);
  });
}

// ─── Connection management ───────────────────────────────────────────────────

function connectToParent(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const conn = net.createConnection(state.socketPath);
  state.parentConn = conn;

  conn.on("connect", () => {
    state.lastAckTimestamp = Date.now();
    const hello: Hello = {
      type: "hello",
      role: "verifier",
      sessionId: state.builderSessionId,
      pid: process.pid,
    };
    try {
      assertDirection(hello, "verifier-to-builder");
      conn.write(encodeEnvelope(hello));
    } catch (err) {
      ctx.ui.notify(
        `verifier: failed to send hello: ${(err as Error).message}`,
        "error",
      );
    }
    requestStatusRender(ctx);
    startPingInterval(ctx);
  });

  conn.on("error", (err) => {
    if (state.shuttingDown) return;
    ctx.ui.notify(
      `verifier: socket error: ${(err as Error).message}`,
      "error",
    );
  });

  conn.on("close", () => {
    if (state.shuttingDown) return;
    state.phase = "disconnected";
    requestStatusRender(ctx);
    setTimeout(() => {
      try {
        ctx.shutdown();
      } catch {
        process.exit(0);
      }
    }, 5000);
  });

  void (async () => {
    try {
      for await (const envelope of readEnvelopes(conn)) {
        try {
          dispatchEnvelope(envelope, pi, ctx);
        } catch (err) {
          ctx.ui.notify(
            `verifier: dispatch error: ${(err as Error).message}`,
            "error",
          );
        }
      }
    } catch (err) {
      if (state.shuttingDown) return;
      ctx.ui.notify(
        `verifier: read loop ended: ${(err as Error).message}`,
        "warning",
      );
    }
  })();
}

function dispatchEnvelope(envelope: Envelope, pi: ExtensionAPI, ctx: ExtensionContext): void {
  assertDirection(envelope, "builder-to-verifier");
  state.lastAckTimestamp = Date.now();

  switch (envelope.type) {
    case "hello_ack": {
      state.helloAcked = true;
      state.phase = "connected";
      requestStatusRender(ctx);
      return;
    }
    case "prompt_ack": {
      const resolver = state.pendingPromptAcks.get(envelope.correlationId);
      if (resolver) {
        state.pendingPromptAcks.delete(envelope.correlationId);
        resolver(envelope);
      }
      return;
    }
    case "ping": {
      const pong: Pong = { type: "pong", nonce: envelope.nonce };
      try {
        assertDirection(pong, "verifier-to-builder");
        state.parentConn?.write(encodeEnvelope(pong));
      } catch (err) {
        ctx.ui.notify(
          `verifier: failed to pong: ${(err as Error).message}`,
          "error",
        );
      }
      return;
    }
    case "pong": {
      state.pendingPongs = 0;
      return;
    }
    case "event": {
      handleBuilderEvent(envelope, pi, ctx);
      return;
    }
    case "bye": {
      state.shuttingDown = true;
      teardown(ctx);
      try {
        ctx.shutdown();
      } catch {
        process.exit(0);
      }
      return;
    }
    default:
      return;
  }
}

function handleBuilderEvent(
  envelope: BuilderEvent,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  const turnLabel = envelope.turnIndex !== undefined ? String(envelope.turnIndex) : "—";
  const iso = new Date(envelope.timestamp).toISOString();
  pi.sendMessage(
    {
      customType: "builder-event",
      content: `🪝 builder event · ${envelope.name} · turn ${turnLabel} · ${iso}`,
      details: envelope,
      display: true,
    },
    { deliverAs: "nextTurn" },
  );

  switch (envelope.name) {
    case "start": {
      state.phase = "connected";
      requestStatusRender(ctx);
      return;
    }
    case "stop": {
      state.currentTurnIndex = envelope.turnIndex ?? state.currentTurnIndex;
      state.phase = "verifying";
      state.promptedThisCycle = false;
      state.confidence = null;
      requestStatusRender(ctx);

      // Resolve the prompt template relative to THIS extension directory
      // (not ctx.cwd) — the global extension ships verify_on_stop.md at
      // <extensionRoot>/prompts/. `__dirname` is portable: it's a native
      // CJS global under jest, and pi's jiti loader provides it too.
      const promptPath = path.join(__dirname, "prompts", "verify_on_stop.md");
      let template: string;
      try {
        template = readFileSync(promptPath, "utf-8");
      } catch (err) {
        ctx.ui.notify(
          `verifier: failed to read ${promptPath}: ${(err as Error).message}`,
          "error",
        );
        return;
      }
      const rendered = templateBody(template, {
        TURN_INDEX: String(state.currentTurnIndex),
        TIMESTAMP: new Date(envelope.timestamp).toISOString(),
        USER_PROMPT: envelope.userPrompt ?? "(no captured user prompt)",
        SESSION_FILE_START_LINE: String(envelope.sessionFileStartLine ?? 1),
        SESSION_FILE_END_LINE: String(envelope.sessionFileEndLine ?? 0),
      });
      try {
        pi.sendUserMessage(rendered, { deliverAs: "followUp" });
      } catch (err) {
        ctx.ui.notify(
          `verifier: sendUserMessage failed: ${(err as Error).message}`,
          "error",
        );
      }
      return;
    }
    case "error": {
      state.phase = "error";
      state.errorDetail = envelope.detail ?? "(no detail)";
      requestStatusRender(ctx);
      return;
    }
  }
}

// ─── Liveness ────────────────────────────────────────────────────────────────

function startPingInterval(ctx: ExtensionContext): void {
  if (state.pingInterval) {
    clearInterval(state.pingInterval);
  }
  state.pingInterval = setInterval(() => {
    if (!state.parentConn || state.parentConn.destroyed) return;
    state.pendingPongs += 1;
    if (state.pendingPongs >= 2) {
      state.phase = "disconnected";
      requestStatusRender(ctx);
      try {
        state.parentConn.destroy();
      } catch {
        // ignore
      }
      return;
    }
    const ping: Ping = { type: "ping", nonce: crypto.randomUUID() };
    try {
      assertDirection(ping, "verifier-to-builder");
      state.parentConn.write(encodeEnvelope(ping));
    } catch {
      // Write failures will surface via the close handler.
    }
  }, 10_000);
}

// ─── Teardown ────────────────────────────────────────────────────────────────

function teardown(ctx: ExtensionContext): void {
  if (state.pingInterval) {
    clearInterval(state.pingInterval);
    state.pingInterval = null;
  }

  if (state.parentConn && !state.parentConn.destroyed) {
    try {
      state.parentConn.write(
        encodeEnvelope({ type: "bye", reason: "verifier shutting down" }),
      );
    } catch {
      // ignore
    }
    try {
      state.parentConn.end();
    } catch {
      // ignore
    }
  }

  if (ctx.hasUI) {
    try {
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
    } catch {
      // ignore
    }
  }
}

// ─── Custom footer ───────────────────────────────────────────────────────────

function installVerifierFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter((_tui, theme, _footerData) => ({
    dispose: () => {},
    invalidate() {},
    render(width: number): string[] {
      const model = ctx.model?.id ?? "no-model";
      const usage = ctx.getContextUsage?.();
      const pct = usage && usage.percent !== null ? usage.percent : 0;
      const filled = Math.round(pct / 10);
      const bar = "#".repeat(filled) + "-".repeat(Math.max(0, 10 - filled));

      const left = theme.fg("dim", ` ${model}`);
      const right = theme.fg("dim", ` [${bar}] ${Math.round(pct)}% `);
      const padLen = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
      return [truncateToWidth(left + " ".repeat(padLen) + right, width)];
    },
  }));
}

function requestStatusRender(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  installVerifierFooter(ctx);
}
