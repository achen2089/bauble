---
name: bauble
description: Launch fresh remote Pi tasks or hand off native sessions with Bauble. Use for host setup, approved task/folder transfer, attaching or messaging a runtime, pulling results, and interrupted-job recovery.
---

# Bauble

Discover the current interface with `bauble help <command>` and `bauble docs --list`. Read `bauble docs quickstart`, `automation`, `configuration`, or `recovery` for the complete manual. JSON in 0.2.0 uses schemaVersion 1 envelopes with named arrays under `data`; accepted/idle/windowRequested never means task done.

Retain stderr as well as stdout: durable IDs are emitted before possible channel loss even with `--json --quiet`. A missing capture manifest is uncertain, not permission to recapture; observe the exact intent/return ID using `status` and read `bauble docs recovery`. Incompatible remote builds require explicit upgrade, never automatic downgrade, replay, or restart.

For explicit agent approval use `run ... --prepare`, `send --session ... --prepare`, or `pull ORIGINAL-ID --prepare` → `inspect EXACT-ID` → user-authorized `approve EXACT-ID --approval-digest SHA256` → `recover EXACT-ID` (REVERSE-ID for returns). Preparation preserves freezes. Never repeat capture to resume, or approve merely to bypass review. `sessions --json` lists only registered local sessions; `status` is cached unless explicitly refreshed.

## Establish the target

1. Inspect `bauble --help`, `bauble ls --json`, and the effective configuration (`BAUBLE_CONFIG` or `~/.config/bauble/config.json`). Preserve any explicit `BAUBLE_STATE` override. For missing configuration, follow the host-setup branch below; report a missing CLI instead of installing without authorization.
2. Distinguish a **fresh task** from an existing registered session or transfer. Confirm the intended workspace/task and configured SSH alias, or the exact existing ID. A unique `--name` handle can select a job; ambiguous names require its UUID. Never choose the newest session implicitly.
3. Match the requested operation below. A transfer's ownership, readiness, and observed execution are separate facts; idle or accepted input does not establish task success.

## Configure a host or launch a fresh task

1. For first setup, use `bauble host add <ssh-alias> --default --profile /absolute/path/profile.json`. Existing configs remain in place; `bauble host list` and `bauble host default <alias>` inspect/select destinations. Without an explicit first profile, only ordinary Pi's saved provider/model/thinking may seed a minimal builtins-only profile. Inspect the selected controlled profile file and `bauble docs configuration` before proceeding. Missing selections or mismatched profiles require configuration, not invented defaults.
2. The remote must already have compatible Bauble, tmux and an independently configured profile/credentials. With explicit user authorization, `bauble setup <alias> --code-root /absolute/remote/code` updates only that remote config field with a backup. The folder must already exist and be private/canonical; state remains separate. Ordinary host setup never provisions software or replaces remote profiles.
3. Confirm the literal task, context and quiescent workspace, then choose one command:

   ```sh
   bauble run --task TASK.md --context CONTEXT.md --host <alias> --name audit
   bauble run /path/to/folder --prompt 'Literal task' --auto-approve
   ```

   The workspace defaults to current cwd; `--cwd /path/to/folder` is an alternative to the positional folder. Task/context paths resolve from the invoking directory. Repeat `--context` for additional text files/directories. Plain folders stay non-Git; Git captures the repository root/history plus exact dirty index/worktree and shows nested-cwd mapping. For exclusions, path limits or profile selection, consult [Fresh remote tasks](../../README.md#fresh-remote-tasks).
4. Default approval is interactive and refuses non-TTY dispatch. Use `--auto-approve` **only when the user explicitly authorized this unattended task**: it durably approves this immutable inventory/digest/target/literal instruction and reports identifiers, not unrelated commands or the full inventory. Use `--prepare` followed by `inspect` when review is needed before dispatch. It leaves secret/path/ownership checks and OS permissions intact; native tools are not sandboxed. This opt-in belongs to `run` and explicit result `pull`, not older `send`.
5. Retain the printed UUID before observing work. The destination creates a genuinely fresh native Pi session; no local seed or transcript is needed. Readiness/idle is not acceptance or task success. Repeating `run` creates another task. After dispatch uncertainty, use `recover <uuid>` for read-only reconciliation, never rerun the task to retry.

Task/context Markdown is literal input, including frontmatter and slash/shell-looking text. Bauble executes no document hooks. Native lifecycle events are retained in the transfer's `journal.jsonl`; use terminal/log/transcript evidence to assess the task. This workflow supports Pi only.

## Transfer a session

- Start with a managed local `bauble pi` session in a committed Git repository. Reopening requires an explicit verified path: `bauble pi --session /absolute/path/to/session.jsonl`. Interactive launch belongs in a human terminal.
- An existing-session transfer needs complete persisted assistant activity. For a fresh destination session use `bauble run` above; there is no `bauble start` or transcript-bootstrap step.
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

Use `open` for a new macOS Terminal window; use `--here` or `bauble attach <transfer-id>` from an interactive terminal elsewhere. These attach to an existing verified Pi process. A window request is not proof of attachment. Missing or uncertain readiness calls for recovery, not a new runtime. `ls` shows name/UUID/host, source/target paths, execution and readiness metadata. Each job has a separate tmux server; prefer verified `open` or `attach` over searching ordinary `tmux ls`.

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

- `bauble pull <transfer-id>` returns a full result inventory and native session into a separate private local Git workspace or plain folder, preserving the original source. It requires persisted native assistant activity and settled/clean state. Obtain approval for that exact result snapshot; `pull --auto-approve` needs explicit unattended-result authorization. Retain the reverse recovery ID. After confirmed local ownership and old-runtime exit, show the printed `bauble pi --session ...` command for explicit reopening. No merge, cleanup or task-success claim follows from pull.
- `bauble recover <transfer-id>` reconciles the existing transfer. For an interrupted return, repeat `pull <original-id>` or use `recover <reverse-id>`; recovery also accepts the original ID.
- Use `bauble recover <transfer-id> --cancel` only for an explicitly requested cancellation. Fresh jobs can cancel only before dispatch intent. After fresh dispatch intent, recovery is read-only even if activation might not have been sent. For migrated sessions, cancellation after authority issuance needs positive durable destination revocation and proof activation never happened; activated or ambiguous launches cannot be cancelled this way.
- An unreachable host does not release ownership. Preserve checkpoints, receipts, tombstones, and locks. Do not delete fencing files, remove orphaned locks, overwrite restoration roots, replay prompts, or restart Pi to force progress.
- If recovery fails closed, stop and report the exact error, transfer/reverse IDs, configured host/state root, and observed ownership/readiness. Manual repair requires investigation rather than guessed state changes.
