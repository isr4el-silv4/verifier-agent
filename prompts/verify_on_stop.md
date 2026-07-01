# Verification Cycle

## Purpose

Verify the work the builder agent completed in turn `<TURN_INDEX>`. This prompt fires automatically every time the builder hits `agent_end`. Read only the slice of the session JSONL that belongs to this turn, check each claim against actual state via your script subcommand, and emit a `## Report` block per your system-prompt contract.

## Variables

TURN_INDEX: <TURN_INDEX>
TIMESTAMP: <TIMESTAMP>
SESSION_FILE_START_LINE: <SESSION_FILE_START_LINE>
SESSION_FILE_END_LINE: <SESSION_FILE_END_LINE>

### Original user prompt

<USER_PROMPT>

## Instructions

- Read **only** the slice `[<SESSION_FILE_START_LINE>..<SESSION_FILE_END_LINE>]` of the builder's session JSONL — not the whole file. The session can grow into the megabytes; scanning the full file is wasteful when the turn's content is bounded.
- Use your `read` tool with:
  - `offset = <SESSION_FILE_START_LINE>`
  - `limit = <SESSION_FILE_END_LINE> - <SESSION_FILE_START_LINE> + 1`
- Verify each claim against actual state via your script subcommand. The script is read-only — its output is the deterministic ground truth. The agent's final assistant text is a CLAIM, never proof.
- If verification fails AND you have a concrete corrective fix, call `verifier_prompt` with `session_id=<BUILDER_SESSION_ID>` **before** emitting the Report. Be specific — exact file paths, failing assertions, suggested fix. The error feedback you give the builder IS the documentation it learns from.
- If you cannot determine how to verify a claim (no fixture, no oracle, no script subcommand), set `STATUS: unsure` in the Report and explicitly state in "What do you need from me to verify this next time?" what's missing. Do NOT guess.
- The original user prompt above is your ground-truth intent — verify against what the user *asked for*, not just what the agent *claimed*. If the agent did extra work the user didn't ask for, that's not a failure; if the agent claimed work the user requested but didn't actually do it, that IS.
- End with exactly one `## Report` block per your system-prompt's output contract. After the Report: stop. No further tool calls. No further prose.

## Workflow

1. Read the session-file slice for this turn using `offset = <SESSION_FILE_START_LINE>` and `limit = <SESSION_FILE_END_LINE> - <SESSION_FILE_START_LINE> + 1`.
2. Parse the JSONL events in the slice. Identify the agent's claims — tool calls (`bash`, `write`, etc.), the final assistant message, and any explicit "I created / applied / inserted X" assertions.
3. For each verifiable claim, run the appropriate script subcommand. Record the exact command, the observed output, and the verdict (PASS / FAIL).
4. For each unverifiable claim, note why — missing oracle, no script subcommand, ambiguous claim.
5. If any verification failed AND the failure has a concrete fix → call `verifier_prompt(session_id=<BUILDER_SESSION_ID>, message=<concrete fix>)`.
6. Emit the `## Report` block per your system-prompt's output contract. Stop.
