/**
 * Tmux + new-OS-window launcher for the Pi Verifier Agent (`$TMUX`-aware).
 *
 * Adapted from the original the-verifier-agent for the global-extension model:
 *   - The verifier model is chosen via the `/verify` wizard and passed in as
 *     `opts.model` — it is NO LONGER a persona frontmatter field.
 *   - `extensionRoot` points at `~/.pi/agent/extensions/verifier-agent/`; the
 *     child entry is `<extensionRoot>/verifier.ts`.
 *   - The `<DOMAIN>` template variable is gone (generic-only v1).
 *
 * Two branches:
 *
 *   1. IN-TMUX BRANCH (`$TMUX` set) — add the verifier as a sibling window in
 *      the builder's existing tmux session.
 *   2. NEW-OS-WINDOW BRANCH (`$TMUX` unset) — detached tmux session + an
 *      attached OS terminal window.
 *
 * The persona system prompt is rendered HERE, before spawn — frontmatter
 * vars (BUILDER_SESSION_ID, SOCKET_PATH, etc.) are substituted into the
 * persona body and passed to the verifier child via `--system-prompt`.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { parseVerifierPersona, templateBody } from "./frontmatter";
import { ensureSocketDir, resolveSocketPath, writeSocketRef } from "./socket-path";

const execFileP = promisify(execFile);

// ─── Public types ────────────────────────────────────────────────────────────

export interface SpawnOpts {
  /** `ctx.sessionManager.getSessionId()` — the canonical session id. */
  sessionId: string;
  /** Absolute path to `~/.pi/agent/personas/verifier.yaml`. */
  agentPath: string;
  /**
   * Absolute path to the verifier-agent extension directory
   * (`~/.pi/agent/extensions/verifier-agent/`). The child entry is resolved as
   * `<extensionRoot>/verifier.ts`.
   */
  extensionRoot: string;
  /** `ctx.cwd` — used for `.pi/state/` breadcrumb resolution + tmux `-c`. */
  cwd: string;
  /**
   * Model id chosen in the `/verify` wizard (e.g. "openai/gpt-5.5"). Passed to
   * the child via `--model` so the verifier uses the user-selected model
   * regardless of global pi config.
   */
  model: string;
  /** `.pi/settings.json` — only `verifier.terminalCommand` is consulted. */
  settings?: { verifier?: { terminalCommand?: string } };
  /** Absolute path to `~/.pi/agent/sessions/<sid>.jsonl` — fed into `<BUILDER_SESSION_FILE>`. */
  builderSessionFile: string;
}

export type SpawnMode = "in-tmux" | "new-window";

export interface SpawnResult {
  tmuxSession: string;
  mode: SpawnMode;
  /** Auto-generated bash wrapper that exports env + runs the verifier pi child. */
  wrapperPath: string;
  /**
   * File the wrapper redirects pi's stderr into (mirrored to the terminal
   * via `tee` so the tmux pane still shows it). Read on spawn-failure to
   * surface pi's actual error in the builder.
   */
  stderrLogPath: string;
}

// ─── spawnVerifierChild ──────────────────────────────────────────────────────

/**
 * Spawn (or re-attach to) the verifier child for `opts.sessionId`.
 *
 * Idempotent: if a tmux session/window with the expected name already
 * exists, returns early without spawning a duplicate.
 */
export async function spawnVerifierChild(opts: SpawnOpts): Promise<SpawnResult> {
  const tmuxSession = `verifier-${opts.sessionId}`;

  // Resolve socket paths up-front — we need SOCKET_PATH for system-prompt
  // templating, and the breadcrumb so the verifier child can find the
  // socket by --builder-session alone.
  const { socketPath, refPath } = resolveSocketPath(opts.sessionId, opts.cwd);
  await ensureSocketDir();
  await writeSocketRef(socketPath, refPath);

  // ─── Render the persona system prompt before spawn ───────────────────
  const personaContent = await fs.readFile(opts.agentPath, "utf8");
  const { frontmatter, body } = parseVerifierPersona(personaContent);

  const rendered = templateBody(body, {
    BUILDER_SESSION_ID: opts.sessionId,
    BUILDER_SESSION_FILE: opts.builderSessionFile,
    MAX_LOOPS: String(frontmatter.max_loops ?? 3),
    SOCKET_PATH: socketPath,
  });

  // Stash the rendered prompt in a tempfile so it's inspectable post-mortem
  // AND so the wrapper script can load it via `$(cat ...)` instead of having
  // it embedded in the tmux command line (avoids macOS ARG_MAX blowup).
  const systemPromptFile = path.join(os.tmpdir(), `pi-verifier-${opts.sessionId}.system.md`);
  await fs.writeFile(systemPromptFile, rendered, { encoding: "utf8", mode: 0o600 });

  // ─── Build the spawn wrapper ─────────────────────────────────────────
  const verifierEntry = path.join(opts.extensionRoot, "verifier.ts");
  const wrapperPath = path.join(os.tmpdir(), `pi-verifier-${opts.sessionId}.spawn.sh`);
  const stderrLogPath = path.join(os.tmpdir(), `pi-verifier-${opts.sessionId}.stderr.log`);
  const wrapperContent = buildSpawnWrapper({
    env: process.env,
    systemPromptFile,
    verifierEntry,
    sessionId: opts.sessionId,
    agentPath: opts.agentPath,
    tools: normalizeToolsList(frontmatter.tools),
    model: opts.model,
    stderrLogPath,
  });
  await fs.writeFile(wrapperPath, wrapperContent, { encoding: "utf8", mode: 0o700 });

  // ─── Idempotency check ───────────────────────────────────────────────
  if (await verifierAlreadyRunning(tmuxSession)) {
    return {
      tmuxSession,
      mode: process.env.TMUX ? "in-tmux" : "new-window",
      wrapperPath,
      stderrLogPath,
    };
  }

  // The actual command tmux runs is a single short string: `bash <wrapper>`.
  const verifierCommand = `bash ${shellSingleQuote(wrapperPath)}`;

  // ─── Branch on $TMUX ─────────────────────────────────────────────────
  if (process.env.TMUX) {
    // ── IN-TMUX BRANCH ──────────────────────────────────────────────
    // Add the verifier as a sibling window in the existing tmux session.
    await execFileP("tmux", [
      "new-window",
      "-n", tmuxSession,
      "-c", opts.cwd,
      verifierCommand,
    ]);
    return { tmuxSession, mode: "in-tmux", wrapperPath, stderrLogPath };
  }

  // ── NEW-OS-WINDOW BRANCH ───────────────────────────────────────────
  // Detached tmux is the source of truth; the OS window is an attached client.
  await execFileP("tmux", [
    "new-session",
    "-d",
    "-s", tmuxSession,
    "-c", opts.cwd,
    verifierCommand,
  ]);
  await applyVerifierTmuxOptions(tmuxSession);
  await openOsWindowAttachedTo(tmuxSession, opts.settings);
  return { tmuxSession, mode: "new-window", wrapperPath, stderrLogPath };
}

// ─── Pure helpers (exported for unit testing) ────────────────────────────────

export interface BuildSpawnWrapperOpts {
  env: NodeJS.ProcessEnv;
  systemPromptFile: string;
  verifierEntry: string;
  sessionId: string;
  agentPath: string;
  /** Comma-separated tool list. Empty / `"*"` → omit `--tools` (pi defaults). */
  tools: string;
  /** Model id from the `/verify` wizard, passed to pi via `--model`. */
  model: string;
  /** File to capture pi's stderr into (mirrored to terminal via tee). */
  stderrLogPath: string;
}

/**
 * Build a wrapper shell script that exports the calling process's env (minus
 * a small skip list) and exec's pi as the verifier child.
 *
 * Why a wrapper instead of `tmux -e KEY=VAL ...`:
 *   macOS's `exec*()` syscalls enforce ARG_MAX (~256KB combined argv + envp).
 *   With ~50 env vars AND the ~10KB rendered system prompt embedded inline,
 *   the tmux command line easily blows ARG_MAX. The wrapper sidesteps it:
 *   file size doesn't count toward exec()'s argv limit, only the live argv
 *   passed to tmux does. Tmux's command becomes simply `bash <wrapper>`.
 *
 * Excluded keys: process-tied (`_`, `OLDPWD`, `PWD` — `-c` covers cwd) and
 * `TMUX*` (so the new session doesn't think it's nested in the parent tmux).
 */
export function buildSpawnWrapper(opts: BuildSpawnWrapperOpts): string {
  const skip = new Set(["_", "OLDPWD", "PWD"]);
  const exports: string[] = [];
  for (const [k, v] of Object.entries(opts.env)) {
    if (v === undefined) continue;
    if (skip.has(k)) continue;
    if (k.startsWith("TMUX")) continue; // don't leak parent tmux state
    // Skip identifiers shells can't validly export (e.g. with `(` or `=`).
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    exports.push(`export ${k}=${shellSingleQuote(v)}`);
  }

  const piArgs = [
    `-e ${shellSingleQuote(opts.verifierEntry)}`,
    "--child",
    `--builder-session ${shellSingleQuote(opts.sessionId)}`,
    `--agent ${shellSingleQuote(opts.agentPath)}`,
    `--system-prompt "$(cat ${shellSingleQuote(opts.systemPromptFile)})"`,
    `--model ${shellSingleQuote(opts.model)}`,
  ];
  if (opts.tools && opts.tools !== "*") {
    piArgs.push(`--tools ${shellSingleQuote(opts.tools)}`);
  }

  return [
    "#!/usr/bin/env bash",
    "# Auto-generated by Pi Verifier launcher.ts.",
    "# Sets up env, runs the verifier pi child, captures stderr to a log.",
    "# Wrapped in a script so the tmux command line stays tiny (avoids",
    "# ARG_MAX on macOS with verbose env).",
    "",
    `STDERR_LOG=${shellSingleQuote(opts.stderrLogPath)}`,
    `: > "$STDERR_LOG"`,
    "",
    "# ─── Env (forwarded from the builder process) ────────────────────────",
    ...exports,
    "",
    "# ─── Run the verifier (capture stderr; mirror to terminal) ───────────",
    "pi \\",
    ...piArgs.map((a) => `  ${a} \\`),
    `  2> >(tee -a "$STDERR_LOG" >&2)`,
    "",
    "EXIT_CODE=$?",
    `echo "" >> "$STDERR_LOG"`,
    `echo "[wrapper] pi exited with code $EXIT_CODE" >> "$STDERR_LOG"`,
    "exit $EXIT_CODE",
    "",
  ].join("\n");
}

/**
 * Normalize the persona's `tools:` frontmatter field into a comma-separated
 * string with no whitespace (matches Pi's `--tools` flag format), and ALWAYS
 * append `verifier_prompt` — that tool is registered by `verifier.ts` and is
 * the system-required transport for sending corrective feedback back to the
 * builder. Persona authors shouldn't have to remember to list it.
 */
export function normalizeToolsList(toolsField: string): string {
  const tools = toolsField
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tools.length === 0) return "";
  if (!tools.includes("verifier_prompt")) tools.push("verifier_prompt");
  return tools.join(",");
}

/**
 * POSIX single-quote shell escaping. Single-quote runs are literal in sh,
 * so we close, emit an escaped quote (`'\''`), and re-open. Result is a
 * single quoted token that round-trips any byte sequence except NUL.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ─── tmux options (new-OS-window sessions only) ──────────────────────────────

async function applyVerifierTmuxOptions(tmuxSession: string): Promise<void> {
  const opts: Array<[string, string]> = [
    ["mouse", "on"],
    ["status", "off"],
    ["history-limit", "10000"],
    ["set-clipboard", "on"],
  ];
  for (const [name, value] of opts) {
    try {
      await execFileP("tmux", ["set-option", "-t", tmuxSession, name, value]);
    } catch {
      // Non-fatal — older tmux may not recognize an option.
    }
  }
}

// ─── killVerifierChild ───────────────────────────────────────────────────────

/**
 * Best-effort teardown. Swallows "session/window not found" errors so it's
 * safe to call from `session_shutdown` regardless of whether the verifier
 * was ever spawned.
 */
export async function killVerifierChild(sessionId: string): Promise<void> {
  const tmuxSession = `verifier-${sessionId}`;
  if (process.env.TMUX) {
    await tmuxSwallowMissing(["kill-window", "-t", tmuxSession]);
    return;
  }
  await tmuxSwallowMissing(["kill-session", "-t", tmuxSession]);
}

// ─── Idempotency helpers ─────────────────────────────────────────────────────

async function verifierAlreadyRunning(tmuxSession: string): Promise<boolean> {
  if (process.env.TMUX) {
    try {
      const { stdout } = await execFileP("tmux", ["list-windows", "-F", "#{window_name}"]);
      const names = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      return names.includes(tmuxSession);
    } catch {
      return false;
    }
  }
  try {
    await execFileP("tmux", ["has-session", "-t", tmuxSession]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxSwallowMissing(args: string[]): Promise<void> {
  try {
    await execFileP("tmux", args);
  } catch (err) {
    const stderr = ((err as { stderr?: string }).stderr ?? "").toLowerCase();
    if (
      stderr.includes("can't find") ||
      stderr.includes("no such") ||
      stderr.includes("session not found") ||
      stderr.includes("window not found") ||
      stderr.includes("no server running")
    ) {
      return;
    }
    throw err;
  }
}

// ─── OS-window dispatch (new-OS-window branch only) ──────────────────────────

async function openOsWindowAttachedTo(
  tmuxSession: string,
  settings: SpawnOpts["settings"],
): Promise<void> {
  const attachCmd = `tmux attach -t ${tmuxSession}`;

  const override = settings?.verifier?.terminalCommand;
  if (override && override.length > 0) {
    const expanded = override.replace(/\{cmd\}/g, attachCmd);
    await execFileP("sh", ["-c", expanded]);
    return;
  }

  if (process.platform === "darwin") {
    const term = process.env.TERM_PROGRAM;
    if (term && (await tryDispatchMacOS(term, attachCmd, tmuxSession))) {
      return;
    }
    if (await tryOpenTerminalApp(attachCmd)) {
      return;
    }
    fallbackInstruction(tmuxSession);
    return;
  }

  if (process.platform === "linux") {
    const explicit = process.env.TERMINAL;
    if (explicit && (await commandExists(explicit))) {
      await spawnLinuxEmulator(explicit, attachCmd, tmuxSession);
      return;
    }
    for (const candidate of ["gnome-terminal", "konsole", "kitty", "alacritty", "xterm"]) {
      if (await commandExists(candidate)) {
        await spawnLinuxEmulator(candidate, attachCmd, tmuxSession);
        return;
      }
    }
    fallbackInstruction(tmuxSession);
    return;
  }

  fallbackInstruction(tmuxSession);
}

async function spawnLinuxEmulator(
  emulator: string,
  attachCmd: string,
  tmuxSession: string,
): Promise<void> {
  switch (path.basename(emulator)) {
    case "gnome-terminal":
      await execFileP(emulator, ["--", "tmux", "attach", "-t", tmuxSession]);
      return;
    case "konsole":
      await execFileP(emulator, ["-e", "tmux", "attach", "-t", tmuxSession]);
      return;
    case "kitty":
    case "alacritty":
    case "xterm":
      await execFileP(emulator, ["-e", "tmux", "attach", "-t", tmuxSession]);
      return;
    default:
      await execFileP(emulator, ["-e", attachCmd]);
      return;
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileP("sh", ["-c", `command -v ${shellSingleQuote(command)}`]);
    return true;
  } catch {
    return false;
  }
}

function fallbackInstruction(tmuxSession: string): void {
  process.stderr.write(
    `Verifier started in detached tmux session. Attach with: tmux attach -t ${tmuxSession}\n`,
  );
}

async function tryDispatchMacOS(
  term: string,
  attachCmd: string,
  tmuxSession: string,
): Promise<boolean> {
  try {
    switch (term) {
      case "Apple_Terminal":
        await execFileP("osascript", [
          "-e",
          `tell application "Terminal"
             activate
             do script "${attachCmd}"
           end tell`,
        ]);
        return true;
      case "iTerm.app":
        await execFileP("osascript", [
          "-e",
          `tell application "iTerm"
             activate
             create window with default profile
             tell current session of current window to write text "${attachCmd}"
           end tell`,
        ]);
        return true;
      case "ghostty":
      case "Ghostty":
        if (await commandExists("ghostty")) {
          await execFileP("ghostty", ["-e", attachCmd]);
        } else {
          await execFileP("open", ["-na", "Ghostty", "--args", "-e", attachCmd]);
        }
        return true;
      case "WezTerm":
        await execFileP("wezterm", [
          "cli",
          "spawn",
          "--new-window",
          "--",
          "tmux",
          "attach",
          "-t",
          tmuxSession,
        ]);
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

async function tryOpenTerminalApp(attachCmd: string): Promise<boolean> {
  try {
    await execFileP("osascript", [
      "-e",
      `tell application "Terminal"
         activate
         do script "${attachCmd}"
       end tell`,
    ]);
    return true;
  } catch {
    return false;
  }
}
