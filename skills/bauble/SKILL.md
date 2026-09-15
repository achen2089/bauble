---
name: bauble
description: Hand off native Pi sessions with Bauble. Use when the user asks to transfer a session over SSH, attach to or message a Bauble runtime, pull work back, or recover an interrupted transfer.
---

# Bauble

## Establish the target

1. Run `bauble ls --json` and inspect the effective Bauble configuration (`BAUBLE_CONFIG` or `~/.config/bauble/config.json`). Preserve any explicit `BAUBLE_STATE` override. Report a missing CLI or configuration as a setup blocker rather than inventing defaults.
2. Identify the user's intended registered session or transfer ID and, for outbound work, a configured SSH alias. Ask if the target is ambiguous; never choose the newest session implicitly.
3. Match the requested operation below. A transfer's ownership, readiness, and observed execution are separate facts; idle or accepted input does not establish task success.

## Transfer a session

- Start with a managed local `bauble pi` session in a committed Git repository. Reopening requires an explicit verified path: `bauble pi --session /absolute/path/to/session.jsonl`. Interactive launch belongs in a human terminal.
- A session needs complete persisted assistant activity before transfer. There is no remote-only `bauble start`; do not fabricate a transcript or adopt an arbitrary session to create a remote runtime.
- Ask the user to quiesce editors, builds, watchers, and other writers before capture.
- In the native terminal, have the user run `/bauble [host]` and review the inventory. CLI capture uses `bauble send --session <registered-path-or-id> --host <ssh-alias>`; an explicit continuation can be supplied with `--instruction-file <path>`.
- Approval must cover the exact inventory, destination, and continuation. Automation requires the matching immutable manifest SHA-256 via `--approval-digest`, after authorized review; do not generate approval merely to bypass the dialog.
- Treat included history, transcripts, resources, and artifacts as sensitive. Secret-name filtering is heuristic. Sensitive file/history inclusion requires explicit consent; credential stores and SSH keys are never transferable.
- Retain the transfer ID and report the observed receipt. Without a continuation, the destination starts idle. With one, native acceptance is not completion.

## Inspect or attach

```sh
bauble ls --json
bauble log <transfer-id> --follow
bauble open <transfer-id>
bauble open <transfer-id> --here
```

Use `open` for a new macOS Terminal window; use `--here` or `bauble attach <transfer-id>` from an interactive terminal elsewhere. These attach to an existing verified Pi process. A window request is not proof of attachment. Missing or uncertain readiness calls for recovery, not a new runtime.

## Message an existing runtime

1. Select the exact transfer and prepare one literal instruction. Messages require a fully idle runtime and do not queue behind busy work.
2. Generate a UUID, retain it in the task record **before submission**, and use it explicitly:

   ```sh
   bauble message <transfer-id> 'Literal instruction' --request-id <uuid>
   bauble message-status <transfer-id> --request-id <uuid>
   ```

   Quote shell arguments safely; for text starting with a dash, put options first and use `--` before the text. Text is one nonempty UTF-8 argument, at most 64 KiB. Shell history and process listings may expose it.
3. Interpret the result:
   - `accepted`: native input acceptance only. Observe the terminal/transcript for actual work.
   - `rejected`: terminal for that UUID. Resolve the cause; a new submission requires an explicit decision and a new UUID.
   - `uncertain`: query status with the same UUID. Never automatically resend or choose a new UUID to bypass uncertainty.
   - `absent`: not proof that a delayed request cannot arrive.
4. Same-ID retries reconcile an existing client intent; they do not retransmit it. Keep the inbox/outbox ledgers intact. Report the UUID and delivery state separately from any evidence of task completion.

Messages and continuations are literal input: `/bauble`, `/skill:...`, templates, and `!command` are not expanded. Messaging never launches, reopens, or changes ownership. Older runtimes without `message-v1` require an explicit lifecycle decision, not an automatic restart.

## Pull or recover

- `bauble pull <transfer-id>` returns a checkpoint into a separate private local repository/worktree, preserving the original checkout. Retain the printed reverse recovery ID. After confirmed local ownership and old-runtime exit, show the printed `bauble pi --session ...` command for explicit reopening.
- `bauble recover <transfer-id>` reconciles the existing transfer. For an interrupted return, repeat `pull <original-id>` or use `recover <reverse-id>`; recovery also accepts the original ID.
- Use `bauble recover <transfer-id> --cancel` only for an explicitly requested cancellation. Cancellation after authority issuance needs positive durable destination revocation and proof activation never happened; activated or ambiguous launches cannot be cancelled this way.
- An unreachable host does not release ownership. Preserve checkpoints, receipts, tombstones, and locks. Do not delete fencing files, remove orphaned locks, overwrite restoration roots, replay prompts, or restart Pi to force progress.
- If recovery fails closed, stop and report the exact error, transfer/reverse IDs, configured host/state root, and observed ownership/readiness. Manual repair requires investigation rather than guessed state changes.
