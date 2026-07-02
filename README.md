<div align="center">
  <img src="https://imgur.com/XV2R8xM.jpeg" alt="pi-verifier-agent banner" style="max-width:800px;">
</div>

# Pi Verifier Agent

Autonomous verification system that watches your Pi coding agent work and validates every claim against actual filesystem state.

## 🛡️ What It Does

When you run `/verify`, this extension spawns a second agent (the **verifier**) in a separate tmux window. After each turn of your main builder agent, the verifier:

1. **Reads the builder's session output** for that turn
2. **Independently verifies every claim** (tool calls, file creations, code changes) using actual filesystem state
3. **Sends corrective feedback** when verification fails, before emitting a structured Report

This catches hallucinations, failed operations, and partial implementations that the builder agent might incorrectly report as complete.

## 🎯 Why Use It

Large language models sometimes claim they've completed work that hasn't actually happened—files not created, commands that failed silently, or code that doesn't match what was described. The verifier agent acts as an independent auditor, ensuring that **what the builder says matches what actually exists**.

## 🚀 Quick Start

### 1. Launch the Verifier

Start a Pi session, then run:

```
/verify
```

This opens a model selection wizard. Choose the AI model you want the verifier to use (can be different from your builder's model).

### 2. Work Normally

Use your builder agent as usual. The verifier watches each turn automatically—no extra commands needed.

### 3. Review Results

- **Verifier window**: Shows live status (connecting → verifying → verified/failed/unsure)
- **Builder window**: Shows corrective prompts when the verifier detects issues
- **Reports**: Full verification details appear in the verifier's window after each turn

## 🔄 The Verification Workflow

```
┌─────────────┐       agent_end        ┌─────────────┐
│   Builder   │ ───────────────────►  │  Verifier   │
│   (main)    │  sends session slice  │  (child)    │
└─────────────┘                       └─────────────┘
       ▲                                     │
       │        corrective prompt           │
       │   (when verification fails)        ▼
       └─────────────────────────────────  Emit Report
```

1. **Start event**: Builder tells verifier a new turn is beginning
2. **Stop event**: Builder finishes, sends session slice to verifier
3. **Verification**: Verifier reads the slice, checks claims against actual state
4. **Corrective loop** (if needed): Verifier uses `verifier_prompt` tool to send specific fixes back to builder (up to `max_loops` times)
5. **Report**: Verifier emits structured status and stops

## ⌨️ Commands

### `/verify` (Main Command)

Spawns the verifier agent with an interactive model selection wizard.

**Usage**:
```
/verify
```

**What happens**:
- Opens a dropdown of available AI models
- Launches verifier in a new tmux window (`verifier-<session-id>`)
- Establishes IPC connection between builder and verifier
- Begins watching subsequent builder turns

**Status bar shows**:
- `◌ connecting...` — establishing socket connection
- `● connected to builder` — ready, waiting for events
- `… verifying...` — checking builder's claims
- `✓ verified` — all claims passed
- `✗ failed` — one or more claims failed
- `⚠ unsure` — couldn't verify (missing oracles)

### `verifier_prompt` (Verifier Tool)

Tool used by the verifier agent to send corrective prompts back to the builder. You can customize or override this tool if you need different behavior.

**Called by**: Verifier agent (not directly by users)

**Parameters**:
- `session_id`: Builder session ID (auto-populated)
- `message`: Specific corrective instructions
- `deliver_as`: `"followUp"` (default) or `"steer"`

**Example** (what verifier does internally):
```yaml
verifier_prompt(session_id="<BUILDER_SESSION_ID>", message="File src/main.ts was not created. Please create it with the function you described.")
```

## ⚙️ Configuration

### Verifier Persona

The verifier's behavior is defined in `~/.pi/agent/personas/verifier.yaml`. This file is automatically installed when the extension loads. Key settings:

- **max_loops**: Maximum corrective prompts per verification cycle (default: 3)
- **tools**: Bash, read, find, grep, edit, ls, verifier_prompt
- **systemPromptMode**: `replace` — uses full verifier system prompt
- **inheritProjectContext**: `false` — verifier only gets session slice, not full project

To customize the verifier's behavior, edit the persona file. Changes apply on next `/verify` run.

### Model Selection

When you run `/verify`, you'll see a model selection wizard. The verifier can use:
- Any model available in your Pi configuration
- Potentially different model than your builder (e.g., cheaper/faster model for verification)

### Environment Variables

The verifier loads `.env` from your project directory, inheriting API keys and configuration.

## 🐛 Troubleshooting

### ❌ Verifier won't start

**Symptom**: `/verify` shows error after model selection

**Common causes**:
- **tmux not installed**: Run `sudo apt install tmux` (Linux) or `brew install tmux` (macOS)
- **Socket path too long**: macOS has a 104-byte limit for Unix-domain socket paths. Try running from a directory with a shorter path
- **Persona file missing**: Check `~/.pi/agent/personas/verifier.yaml` exists and is valid YAML

### 💨 Verifier window disappears

**Symptom**: Verifier tmux session closes shortly after starting

**Check**:
- Look for error messages in the builder window
- Verify the selected model has valid API credentials
- Ensure `verifier.yaml` has valid frontmatter (name, description, tools, systemPromptMode, inheritProjectContext, interactive)

### 🔌 "verifier_prompt rejected: socket closed"

**Symptom**: Verifier tries to send corrective prompt but fails

**Causes**:
- Connection lost between builder and verifier
- Builder session ended unexpectedly
- Timeout waiting for prompt acknowledgment

**Fix**: Restart `/verify` in a new session.

### ❓ Verification always says "unsure"

**Symptom**: Verifier reports `STATUS: unsure` for every turn

**Cause**: Verifier lacks tools or oracles to verify claims

**Fix**: Add appropriate verification scripts or tools to the verifier's persona, or adjust claims to be more verifiable.

### 🔁 "max loops exceeded"

**Symptom**: Verifier escalates to human after `max_loops` failed corrections

**Cause**: Builder couldn't fix the issue within the retry limit

**Fix**:
- Increase `max_loops` in `verifier.yaml`
- Or intervene manually to guide the builder

## 🏗️ Architecture

[For deep-dive details, see the Architecture section below]

### 📐 Process Model

The extension uses a **two-agent architecture**:

- **Builder process**: Your main Pi coding agent
- **Verifier process**: Separate Pi instance spawned in tmux window

Communication happens via **Unix-domain sockets** using a custom envelope protocol.

### 📡 IPC Protocol

Both sides exchange JSONL envelopes with type discriminators:

**Builder → Verifier**:
- `hello_ack`: Acknowledges verifier connection
- `event`: Lifecycle events (start, stop, error)
- `ping`: Liveness check
- `prompt_ack`: Acknowledges corrective prompt receipt

**Verifier → Builder**:
- `hello`: Initial connection handshake
- `prompt`: Corrective feedback using `verifier_prompt` tool
- `report`: Structured verification results
- `pong`: Liveness response
- `bye`: Graceful shutdown

### 🔄 Session Lifecycle

1. **session_start**: Builder creates socket server, sets up footer, loads .env
2. **attach()**: User runs `/verify` → model wizard → spawn verifier child
3. **hello/hello_ack**: Verifier connects, handshake completes
4. **before_agent_start**: Builder fires `start` event with turn metadata
5. **agent_end**: Builder fires `stop` event with session file line range
6. **Verification**: Verifier reads session slice, checks claims
7. **Corrective loop** (if needed): `verifier_prompt` → `prompt_ack`
8. **report**: Verifier emits final status and sections
9. **session_shutdown**: Cleanup sockets, kill verifier child

### 📋 Report Structure

The verifier emits a `## Report` block with:

```
STATUS: verified | failed | unsure
CONFIDENCE: VERIFIED | FEEDBACK | FAILED | PARTIAL

### What did you verify?
- claim 1: PASS/FAIL (evidence)
- claim 2: PASS/FAIL (evidence)

### What could you not verify?
- ambiguous claims, missing oracles

### What feedback did you give?
none | corrective prompt summary

### What do you need from me to verify this next time?
missing fixtures, scripts, oracles

### Verification metadata
- turn_index: N
- atomic_claims_total: N
- atomic_claims_verified: N
- atomic_claims_failed: N
- atomic_claims_unverified: N
```

### 💓 Liveness Monitoring

- Both sides send `ping`/`pong` every 10 seconds
- 2 missed pongs → declare connection dead
- Builder monitors uncaught exceptions/unhandled rejections and forwards to verifier as `error` events

### 📁 File Locations

- **Socket**: `/tmp/pi-verifier-<session-id>-<hash>/socket` (auto-cleaned)
- **Session file**: `~/.pi/agent/sessions/<session-id>.jsonl`
- **Persona**: `~/.pi/agent/personas/verifier.yaml`
- **Stderr log**: `/tmp/pi-verifier-<session-id>-stderr.log`

### 📦 Key Files

- `index.ts`: Builder-side extension (socket server, lifecycle, command handler)
- `verifier.ts`: Verifier-side extension (socket client, report parsing, verifier_prompt tool)
- `_shared/ipc.ts`: Envelope protocol, serialization, type guards
- `_shared/launcher.ts`: Spawns verifier child in tmux with correct flags
- `_shared/report.ts`: Parses `## Report` blocks from verifier output
- `_shared/socket-path.ts`: Resolves safe socket paths (handles macOS length limits)
- `verifier.yaml`: Default verifier persona (auto-installed to `~/.pi/agent/personas/`)
- `prompts/verify_on_stop.md`: Template injected into verifier on each `stop` event

---

**For implementation details or to contribute, see the source code in `index.ts`, `verifier.ts`, and the `_shared/` directory.**

This project was inpired by: [disler/the-verifier-agent](https://github.com/disler/the-verifier-agent)