/**
 * Builder-side extension for the Pi Verifier Agent (global extension entry).
 *
 * Discovered automatically via `package.json` → `pi.extensions: ["./index.ts"]`.
 * Owns the unix-domain socket SERVER side of the verifier IPC channel, spawns
 * the verifier child (in tmux) after a mandatory model-selection wizard, and
 * forwards builder lifecycle ticks (`start`/`stop`/`error`) over the socket.
 * Receives `prompt` / `report` envelopes back and routes them into the builder
 * session via `pi.sendUserMessage` and `pi.sendMessage` respectively.
 *
 * Adapted from the original the-verifier-agent `verifiable.ts`:
 *   - REMOVED the `--verifiable` auto-spawn flag and session_start auto-spawn.
 *     The verifier is ONLY spawned via `/verify`.
 *   - ADDED a mandatory model-selection wizard (`ctx.modelRegistry.getAvailable()`
 *     + `ctx.ui.select()`); the chosen model is passed to the launcher.
 *   - Persona is read from `~/.pi/agent/personas/verifier.yaml` (the user's YAML
 *     format — no `model`/`domain` fields).
 *   - `extensionRoot` (this directory) is passed to the launcher so it can
 *     resolve `verifier.ts`.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BuilderInputEditor,
  type ConnectionPhase as FooterConnectionPhase,
} from "./verifiable-footer";

import {
  type Envelope,
  type Prompt,
  type PromptAck,
  type Report,
  assertDirection,
  encodeEnvelope,
  isBye,
  isHello,
  isPing,
  isPong,
  isPrompt,
  isReport,
  readEnvelopes,
} from "./_shared/ipc";
import { loadDotEnv } from "./_shared/env";
import { parseVerifierPersona } from "./_shared/frontmatter";
import { killVerifierChild, spawnVerifierChild } from "./_shared/launcher";
import { cleanup, ensureSocketDir, resolveSocketPath } from "./_shared/socket-path";

// This file's directory — the global extension root. `__dirname` is portable:
// native CJS global under jest, and pi's jiti loader provides it too.
const extensionRoot = __dirname;

// ─── Module-local state (closure-captured, not global) ───────────────────────

type ConnectionPhase = "idle" | "disconnected" | "spawning" | "connected" | "error";

interface VerifiableState {
  phase: ConnectionPhase;
  sessionId: string;
  socketPath: string;
  refPath: string;
  socketServer: net.Server | null;
  verifierConn: net.Socket | null;
  pendingPongs: number;
  pingInterval: NodeJS.Timeout | null;
  pingNonces: Set<string>;
  pendingPromptAcks: Map<string, (ack: PromptAck) => void>;
  loopCount: number;
  maxLoops: number;
  lastReportRaw: string;
  attached: boolean;
  spawnInFlight: boolean;
  turnIndex: number;
  injectedNext: boolean;
  /** Resolved path to the builder's session JSONL — for turn-byte-offset capture. */
  sessionFilePath: string;
  /** Most recent NON-extension user prompt text (captured from input event). */
  lastUserPrompt: string;
  /** Line count at before_agent_start — start line of this turn's slice. */
  turnStartLine: number;
  uncaughtListener: ((err: unknown) => void) | null;
  unhandledListener: ((reason: unknown) => void) | null;
  /** Bound `tui.requestRender` captured from the editor factory. */
  requestRender: (() => void) | null;
  /** Timer for the spawn-hello timeout diagnostic. */
  spawnTimeout: NodeJS.Timeout | null;
  spawnWrapperPath: string;
  spawnStderrLogPath: string;
}

const SPAWN_HELLO_TIMEOUT_MS = 3000;

export default function verifiable(pi: ExtensionAPI): void {
  // The global entry auto-loads in EVERY pi session — including the verifier
  // child that the launcher spawns via `pi -e verifier.ts --child ...`. When
  // this builder-side extension runs inside that child, it must be a COMPLETE
  // no-op: otherwise its `session_start` installs the interactive
  // `BuilderInputEditor`, clobbering the child's locked `VerifierStatusBar`
  // (the window would look like a normal, typeable pi).
  //
  // We can't use `pi.getFlag("child")` here — flag values from the CLI are
  // applied AFTER factories run (during `resourceLoader.reload()`), so the
  // flag is still unset at factory-load time. `process.argv` is available
  // immediately and reliably carries `--child` for the child process.
  if (process.argv.includes("--child")) return;

  const state: VerifiableState = {
    phase: "idle",
    sessionId: "",
    socketPath: "",
    refPath: "",
    socketServer: null,
    verifierConn: null,
    pendingPongs: 0,
    pingInterval: null,
    pingNonces: new Set<string>(),
    pendingPromptAcks: new Map<string, (ack: PromptAck) => void>(),
    loopCount: 0,
    maxLoops: 3,
    lastReportRaw: "",
    attached: false,
    spawnInFlight: false,
    turnIndex: 0,
    injectedNext: false,
    sessionFilePath: "",
    lastUserPrompt: "",
    turnStartLine: 0,
    uncaughtListener: null,
    unhandledListener: null,
    requestRender: null,
    spawnTimeout: null,
    spawnWrapperPath: "",
    spawnStderrLogPath: "",
  };

  // ─── /verify command (mandatory model wizard) ─────────────────────────

  pi.registerCommand("verify", {
    description: "Spawn the verifier (model selection wizard)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (state.attached) {
        safeNotify(ctx, "verifier already attached", "info");
        return;
      }

      // ── Mandatory model selection wizard ──────────────────────────
      const available = ctx.modelRegistry.getAvailable();
      if (!available || available.length === 0) {
        safeNotify(ctx, "No models available. Configure an API key first.", "error");
        return;
      }

      const modelOptions = available.map((m) => `${m.provider}/${m.id}`);
      const selected = await ctx.ui.select("Select verifier model", modelOptions);

      if (!selected) {
        safeNotify(ctx, "Cancelled — verifier not started", "info");
        return;
      }

      // ctx.ui.select returns the chosen label; find the matching model.
      const selectedIndex = modelOptions.indexOf(selected);
      const selectedModel = available[selectedIndex];
      const modelId = `${selectedModel.provider}/${selectedModel.id}`;

      // ── Launch ─────────────────────────────────────────────────────
      await attach(ctx, modelId);
    },
  });

  // ─── Lifecycle wiring ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    state.sessionId = ctx.sessionManager.getSessionId();

    const sessionFile = ctx.sessionManager.getSessionFile();
    state.sessionFilePath =
      sessionFile ?? path.join(os.homedir(), ".pi/agent/sessions", `${state.sessionId}.jsonl`);

    // Load .env from the user's cwd into process.env BEFORE anything else.
    // Existing env vars are preserved; .env fills gaps. The launcher forwards
    // process.env to the verifier via the wrapper script.
    const envResult = await loadDotEnv(ctx.cwd);
    if (!envResult.loaded && envResult.reason) {
      safeNotify(ctx, `verifier: ${envResult.reason}`, "warning");
    }

    setFooter(ctx, "idle");

    if (ctx.hasUI) {
      ctx.ui.setEditorComponent(
        (tui, theme, kb) => {
          state.requestRender = () => {
            try {
              tui.requestRender();
            } catch {
              // best-effort — pi may have torn down the TUI by now
            }
          };
          return new BuilderInputEditor(
            tui,
            theme,
            kb,
            {
              getPhase: () => state.phase as FooterConnectionPhase,
              getSessionId: () => state.sessionId,
            },
            ctx,
          );
        },
      );

      // Hide pi's default footer — the input-bar borders already carry model +
      // ctx % + verifier-status.
      try {
        ctx.ui.setFooter(() => ({
          dispose: () => {},
          invalidate() {},
          render: () => [],
        }));
      } catch {
        // best-effort — non-critical
      }
    }
  });

  // Track the source of the most recent input so before_agent_start can tell
  // whether the upcoming run was triggered by a real user prompt or by our own
  // pi.sendUserMessage injection.
  pi.on("input", async (event, _ctx) => {
    state.injectedNext = event.source === "extension";
    if (event.source !== "extension" && typeof event.text === "string") {
      state.lastUserPrompt = event.text;
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    try {
      if (state.injectedNext) {
        // Verifier-corrective turn — don't reset loopCount, don't fire start.
        state.injectedNext = false;
        return;
      }

      // Genuine user prompt: fresh verification cycle.
      state.loopCount = 0;
      state.turnIndex += 1;

      const linesBefore = await currentSessionFileLineCount(state.sessionFilePath);
      state.turnStartLine = linesBefore + 1;

      sendEnvelope({
        type: "event",
        name: "start",
        sessionId: state.sessionId,
        turnIndex: state.turnIndex,
        timestamp: Date.now(),
        userPrompt: state.lastUserPrompt,
        sessionFileStartLine: state.turnStartLine,
      });
    } catch (err) {
      reportEventError(err);
    }
  });

  pi.on("agent_end", async (_event, _ctx) => {
    try {
      const endLine = await currentSessionFileLineCount(state.sessionFilePath);

      sendEnvelope({
        type: "event",
        name: "stop",
        sessionId: state.sessionId,
        turnIndex: state.turnIndex,
        timestamp: Date.now(),
        userPrompt: state.lastUserPrompt,
        sessionFileStartLine: state.turnStartLine,
        sessionFileEndLine: endLine,
      });
    } catch (err) {
      reportEventError(err);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx?.hasUI) {
      try {
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.setFooter(undefined);
      } catch {
        // ignore
      }
    }
    state.requestRender = null;
    clearSpawnTimeout();
    await detach();
  });

  // ─── Internal: attach() — the lifecycle entry point ───────────────────

  async function attach(ctx: ExtensionContext | ExtensionCommandContext, modelId: string): Promise<void> {
    if (state.attached || state.spawnInFlight) {
      safeNotify(ctx, "verifier already attached", "info");
      return;
    }
    state.spawnInFlight = true;
    state.phase = "spawning";
    setFooter(ctx, "spawning");

    try {
      // Persona — global YAML format at ~/.pi/agent/personas/verifier.yaml.
      const agentPath = path.join(
        process.env.HOME || os.homedir(),
        ".pi", "agent", "personas", "verifier.yaml",
      );

      // Pull max_loops from the persona before spawning so the builder-side
      // counter matches the verifier's authoritative limit.
      try {
        const personaContent = await fs.readFile(agentPath, "utf8");
        const { frontmatter } = parseVerifierPersona(personaContent);
        if (typeof frontmatter.max_loops === "number" && frontmatter.max_loops > 0) {
          state.maxLoops = frontmatter.max_loops;
        }
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        safeNotify(ctx, `verifier: failed to read persona at ${agentPath}: ${msg}`, "error");
        surfaceVerifierError(
          [
            `Could not load verifier persona at:`,
            `  ${agentPath}`,
            ``,
            `Reason: ${msg}`,
            ``,
            `Check that the file exists and the frontmatter is well-formed`,
            `(required: name, description, tools, systemPromptMode,`,
            `inheritProjectContext, interactive).`,
          ].join("\n"),
        );
        state.phase = "error";
        setFooter(ctx, "error");
        state.spawnInFlight = false;
        return;
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      const builderSessionFile =
        sessionFile ?? path.join(os.homedir(), ".pi/agent/sessions", `${state.sessionId}.jsonl`);

      const { socketPath, refPath } = resolveSocketPath(state.sessionId, ctx.cwd);
      state.socketPath = socketPath;
      state.refPath = refPath;

      await startSocketServer(ctx);

      try {
        const spawnResult = await spawnVerifierChild({
          sessionId: state.sessionId,
          agentPath,
          extensionRoot,
          cwd: ctx.cwd,
          builderSessionFile,
          model: modelId,
          settings: undefined,
        });
        state.spawnWrapperPath = spawnResult.wrapperPath;
        state.spawnStderrLogPath = spawnResult.stderrLogPath;
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        safeNotify(ctx, `verifier: launcher failed: ${msg}`, "error");
        surfaceVerifierError(
          [
            `Verifier launcher threw before tmux could start the child.`,
            ``,
            `Reason: ${msg}`,
            ``,
            `This usually means tmux isn't installed, the persona file is`,
            `unreadable, or the resolved socket path exceeds macOS's 104-byte`,
            `sun_path limit.`,
          ].join("\n"),
        );
        state.phase = "error";
        setFooter(ctx, "error");
        await stopSocketServer();
        state.spawnInFlight = false;
        return;
      }

      state.attached = true;
      setFooter(ctx, "spawning");
      installCrashForwarders();
      armSpawnTimeout(ctx);
    } finally {
      state.spawnInFlight = false;
    }
  }

  // ─── Internal: socket server ──────────────────────────────────────────

  async function startSocketServer(ctx: ExtensionContext): Promise<void> {
    await ensureSocketDir();

    try {
      await fs.unlink(state.socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        safeNotify(ctx,
          `verifier: failed to unlink stale socket: ${(err as Error).message}`,
          "warning",
        );
      }
    }

    const server = net.createServer((conn) => handleConnection(conn, ctx));
    state.socketServer = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(state.socketPath);
    });
  }

  function handleConnection(conn: net.Socket, ctx: ExtensionContext): void {
    if (state.verifierConn) {
      try {
        conn.write(encodeEnvelope({ type: "bye", reason: "duplicate connection" }));
      } catch {
        // ignore
      }
      conn.destroy();
      return;
    }
    state.verifierConn = conn;

    conn.on("close", () => {
      cleanupConnection(ctx);
    });
    conn.on("error", (err) => {
      safeNotify(ctx, `verifier: socket error: ${err.message}`, "warning");
    });

    void readEnvelopeLoop(conn, ctx);
  }

  async function readEnvelopeLoop(conn: net.Socket, ctx: ExtensionContext): Promise<void> {
    try {
      for await (const envelope of readEnvelopes(conn)) {
        try {
          assertDirection(envelope, "verifier-to-builder");
        } catch (err) {
          safeNotify(ctx, `verifier: dropped envelope (${(err as Error).message})`, "warning");
          continue;
        }
        try {
          await dispatch(envelope, conn, ctx);
        } catch (err) {
          safeNotify(ctx,
            `verifier: dispatch error on ${envelope.type}: ${(err as Error).message}`,
            "warning",
          );
        }
      }
    } catch (err) {
      safeNotify(ctx, `verifier: read loop ended: ${(err as Error).message}`, "warning");
    }
  }

  async function dispatch(
    envelope: Envelope,
    conn: net.Socket,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (isHello(envelope)) {
      conn.write(
        encodeEnvelope({ type: "hello_ack", sessionId: state.sessionId }),
      );
      clearSpawnTimeout();
      state.phase = "connected";
      setFooter(ctx, "connected");
      startLiveness(conn, ctx);
      return;
    }

    if (isPrompt(envelope)) {
      await handlePrompt(envelope, conn, ctx);
      return;
    }

    if (isReport(envelope)) {
      handleReport(envelope);
      return;
    }

    if (isPing(envelope)) {
      conn.write(encodeEnvelope({ type: "pong", nonce: envelope.nonce }));
      return;
    }

    if (isPong(envelope)) {
      state.pendingPongs = 0;
      state.pingNonces.delete(envelope.nonce);
      return;
    }

    if (isBye(envelope)) {
      safeNotify(ctx, `verifier: bye (${envelope.reason})`, "info");
      cleanupConnection(ctx);
      return;
    }

    safeNotify(ctx, `verifier: unexpected envelope type "${envelope.type}"`, "warning");
  }

  async function handlePrompt(
    envelope: Prompt,
    conn: net.Socket,
    _ctx: ExtensionContext,
  ): Promise<void> {
    if (envelope.sessionId !== state.sessionId) {
      const ack: PromptAck = {
        type: "prompt_ack",
        sessionId: state.sessionId,
        correlationId: envelope.correlationId,
        ok: false,
        error: `sessionId mismatch (got ${envelope.sessionId}, expected ${state.sessionId})`,
      };
      conn.write(encodeEnvelope(ack));
      return;
    }

    state.loopCount += 1;

    if (state.loopCount > state.maxLoops) {
      const ack: PromptAck = {
        type: "prompt_ack",
        sessionId: state.sessionId,
        correlationId: envelope.correlationId,
        ok: false,
        error: "max loops exceeded",
      };
      conn.write(encodeEnvelope(ack));

      const escalation =
        `Verifier failed ${state.loopCount - 1} times — escalating to human.\n\n` +
        (state.lastReportRaw.length > 0
          ? `Latest report:\n\n${state.lastReportRaw}`
          : "(no report content captured)");
      pi.sendMessage(
        {
          customType: "verifier-escalation",
          content: escalation,
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
      return;
    }

    state.injectedNext = true;
    try {
      pi.sendUserMessage(envelope.message, {
        deliverAs: envelope.deliverAs ?? "followUp",
      });
    } catch (err) {
      state.injectedNext = false;
      const ack: PromptAck = {
        type: "prompt_ack",
        sessionId: state.sessionId,
        correlationId: envelope.correlationId,
        ok: false,
        error: `sendUserMessage failed: ${(err as Error).message}`,
      };
      conn.write(encodeEnvelope(ack));
      return;
    }

    const ack: PromptAck = {
      type: "prompt_ack",
      sessionId: state.sessionId,
      correlationId: envelope.correlationId,
      ok: true,
    };
    conn.write(encodeEnvelope(ack));
  }

  function handleReport(envelope: Report): void {
    // The verifier renders its full Report in its own window's scrollback. We
    // intentionally do NOT echo it into the builder's chat. We just stash the
    // raw text so the max-loops escalation path can include it inline.
    state.lastReportRaw = envelope.raw;
  }

  // ─── Internal: spawn diagnostic (failure path only) ───────────────────

  function surfaceVerifierError(content: string): void {
    try {
      pi.sendMessage(
        {
          customType: "verifier-error",
          content,
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
    } catch {
      process.stderr.write(`[verifier-error]\n${content}\n`);
    }
  }

  function armSpawnTimeout(ctx: ExtensionContext): void {
    clearSpawnTimeout();
    state.spawnTimeout = setTimeout(() => {
      if (state.phase !== "spawning") return;
      void diagnoseSpawnFailure(ctx);
    }, SPAWN_HELLO_TIMEOUT_MS);
  }

  function clearSpawnTimeout(): void {
    if (state.spawnTimeout) {
      clearTimeout(state.spawnTimeout);
      state.spawnTimeout = null;
    }
  }

  async function diagnoseSpawnFailure(ctx: ExtensionContext): Promise<void> {
    const tmuxSession = `verifier-${state.sessionId}`;
    let alive = false;
    try {
      await execFileP("tmux", ["has-session", "-t", tmuxSession]);
      alive = true;
    } catch {
      alive = false;
    }

    const stderrTail = await readStderrTail(state.spawnStderrLogPath);

    const sections: string[] = [];
    if (alive) {
      sections.push(
        `Verifier did not connect within ${SPAWN_HELLO_TIMEOUT_MS / 1000}s.`,
        ``,
        `The tmux session \`${tmuxSession}\` is still alive — pi is running`,
        `but never reached the socket-connect path. Likely cause: the verifier`,
        `extension threw before \`net.createConnection\`, OR the socket dir`,
        `permissions changed.`,
      );
    } else {
      sections.push(
        `Verifier child died before connecting.`,
        ``,
        `The tmux session \`${tmuxSession}\` is gone — pi exited shortly`,
        `after spawn. The captured stderr below should name the cause.`,
      );
    }

    if (stderrTail) {
      sections.push(``, `── pi stderr (tail) ──`, stderrTail.trimEnd());
    } else {
      sections.push(
        ``,
        `── pi stderr ──`,
        `(no stderr captured — log at ${state.spawnStderrLogPath} is empty or unreadable)`,
      );
    }

    sections.push(
      ``,
      `Reproduce manually:  bash ${state.spawnWrapperPath}`,
    );

    surfaceVerifierError(sections.join("\n"));

    state.phase = "error";
    state.attached = false;
    setFooter(ctx, "error");
    removeCrashForwarders();
    await stopSocketServer().catch(() => undefined);
    void killVerifierChild(state.sessionId).catch(() => undefined);
  }

  async function readStderrTail(logPath: string): Promise<string> {
    if (!logPath) return "";
    try {
      const buf = await fs.readFile(logPath, "utf8");
      if (!buf) return "";
      const MAX_BYTES = 4096;
      const MAX_LINES = 60;
      let tail = buf.length > MAX_BYTES ? buf.slice(buf.length - MAX_BYTES) : buf;
      const lines = tail.split("\n");
      if (lines.length > MAX_LINES) {
        tail = lines.slice(lines.length - MAX_LINES).join("\n");
      }
      return tail;
    } catch {
      return "";
    }
  }

  // ─── Internal: liveness ───────────────────────────────────────────────

  function startLiveness(conn: net.Socket, ctx: ExtensionContext): void {
    if (state.pingInterval) return;
    state.pingInterval = setInterval(() => {
      sendPing(conn, ctx);
    }, 10_000);
  }

  function sendPing(conn: net.Socket, ctx: ExtensionContext): void {
    if (state.verifierConn !== conn || conn.destroyed) {
      stopLiveness();
      return;
    }
    const nonce = randomUUID();
    state.pingNonces.add(nonce);

    try {
      conn.write(encodeEnvelope({ type: "ping", nonce }));
    } catch {
      return;
    }

    setTimeout(() => {
      if (state.pingNonces.has(nonce)) {
        state.pingNonces.delete(nonce);
        state.pendingPongs += 1;
        if (state.pendingPongs >= 2) {
          safeNotify(ctx, "verifier: 2 missed pongs — declaring dead", "warning");
          declareDead(ctx);
        }
      }
    }, 10_000);
  }

  function stopLiveness(): void {
    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = null;
    }
    state.pingNonces.clear();
    state.pendingPongs = 0;
  }

  function declareDead(ctx: ExtensionContext): void {
    stopLiveness();
    if (state.verifierConn) {
      try {
        state.verifierConn.destroy();
      } catch {
        // ignore
      }
    }
    void killVerifierChild(state.sessionId).catch(() => undefined);
    state.phase = "disconnected";
    state.attached = false;
    state.verifierConn = null;
    removeCrashForwarders();
    setFooter(ctx, "disconnected");
  }

  function cleanupConnection(ctx: ExtensionContext): void {
    stopLiveness();
    state.verifierConn = null;
    state.attached = false;
    state.phase = "disconnected";
    removeCrashForwarders();
    setFooter(ctx, "disconnected");
  }

  // ─── Internal: detach (session_shutdown teardown) ─────────────────────

  async function detach(): Promise<void> {
    if (state.verifierConn) {
      try {
        state.verifierConn.write(
          encodeEnvelope({ type: "bye", reason: "session_shutdown" }),
        );
      } catch {
        // ignore
      }
    }
    stopLiveness();

    if (state.verifierConn) {
      try {
        state.verifierConn.end();
      } catch {
        // ignore
      }
      state.verifierConn = null;
    }

    await stopSocketServer();

    if (state.socketPath && state.refPath) {
      try {
        await cleanup(state.socketPath, state.refPath);
      } catch {
        // best-effort
      }
    }

    try {
      await killVerifierChild(state.sessionId);
    } catch {
      // best-effort
    }

    state.attached = false;
    state.phase = "disconnected";
    removeCrashForwarders();
  }

  async function stopSocketServer(): Promise<void> {
    const server = state.socketServer;
    if (!server) return;
    state.socketServer = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  // ─── Internal: crash forwarders (only while attached) ─────────────────

  function installCrashForwarders(): void {
    if (state.uncaughtListener || state.unhandledListener) return;
    const onUncaught = (err: unknown): void => {
      sendEnvelope({
        type: "event",
        name: "error",
        sessionId: state.sessionId,
        detail: errMessage(err),
        timestamp: Date.now(),
      });
    };
    const onUnhandled = (reason: unknown): void => {
      sendEnvelope({
        type: "event",
        name: "error",
        sessionId: state.sessionId,
        detail: errMessage(reason),
        timestamp: Date.now(),
      });
    };
    state.uncaughtListener = onUncaught;
    state.unhandledListener = onUnhandled;
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);
  }

  function removeCrashForwarders(): void {
    if (state.uncaughtListener) {
      process.removeListener("uncaughtException", state.uncaughtListener);
      state.uncaughtListener = null;
    }
    if (state.unhandledListener) {
      process.removeListener("unhandledRejection", state.unhandledListener);
      state.unhandledListener = null;
    }
  }

  function reportEventError(err: unknown): void {
    sendEnvelope({
      type: "event",
      name: "error",
      sessionId: state.sessionId,
      detail: errMessage(err),
      timestamp: Date.now(),
    });
  }

  function safeNotify(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void {
    try {
      ctx.ui.notify(message, level);
    } catch {
      const prefix = level === "error" ? "ERROR" : level === "warning" ? "WARN" : "INFO";
      process.stderr.write(`[${prefix}] ${message}\n`);
    }
  }

  function sendEnvelope(envelope: Envelope): void {
    const conn = state.verifierConn;
    if (!conn || conn.destroyed) return;
    try {
      assertDirection(envelope, "builder-to-verifier");
    } catch {
      return;
    }
    try {
      conn.write(encodeEnvelope(envelope));
    } catch {
      // ignore — close handler will clean up
    }
  }

  function setFooter(
    _ctx: ExtensionContext,
    label: ConnectionPhase,
  ): void {
    state.phase = label;
    state.requestRender?.();
  }

  async function currentSessionFileLineCount(sessionPath: string): Promise<number> {
    if (!sessionPath) return 0;
    try {
      const buf = await fs.readFile(sessionPath);
      let count = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a /* \n */) count++;
      }
      return count;
    } catch {
      return 0;
    }
  }

  function errMessage(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}
