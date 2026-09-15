# Quickstart

Bauble 0.2.0 transfers native Pi 0.85.1 sessions and runs fresh literal tasks over SSH. Accepted input, idle execution, and a requested terminal window are **not task completion**. It never provisions software or automatically restarts an uncertain runtime.

## Configure existing software

Install the current Bauble build separately on both ends. The remote host must be Linux, have Node >=22.19, Git, tmux >=3.2, and `bauble` on noninteractive SSH PATH. Configure the same controlled profile and independent provider credentials on both ends. See `bauble docs configuration` before running setup; setup can write Bauble configuration but never installs software or copies credentials.

```sh
bauble host add worker --profile /absolute/profile.json --default
bauble host list
# Optional: explicitly authorize a separate, existing user-owned code parent.
bauble host add worker --code-root /absolute/remote/code
```

## Start a fresh task

Quiesce editors, builds, watchers and other writers before snapshotting. Review files/history for secrets: heuristic exclusions are not a security proof. A folder or Git workspace is captured immutably; plain folders are restored into a private synthetic repository. Context inputs are literal UTF-8 snapshots, not hooks. Repeating `run` creates a **new task**.

```sh
bauble run ./project --task TASK.md --context notes.txt --host worker --name audit --prepare
# Or choose --prompt 'Literal task' instead of --task.
bauble inspect EXACT-ID
# Only after the user authorizes this exact inventory, instruction and destination:
bauble approve EXACT-ID --approval-digest EXACT-SHA256
bauble recover EXACT-ID
bauble status EXACT-ID
bauble open EXACT-ID
bauble log EXACT-ID
```

`--prepare` is successful without uploading or dispatching. Retain its exact ID and digest. `status` is cached; `status --refresh` observes exact-bound remote durable state, **not process liveness**, and does not update local status. `open` requests a macOS Terminal window; on Linux use `open EXACT-ID --here` or `attach EXACT-ID` in a terminal. These attach to an existing verified runtime, not a replacement.

## Transfer an existing session

Start managed Pi in a committed Git repository. A transferable session needs complete persisted assistant activity. Do not invent a transcript or adopt an arbitrary file for capture.

```sh
bauble pi
bauble sessions --json
bauble send --session EXACT-REGISTERED-ID --host worker --prepare
bauble inspect EXACT-TRANSFER-ID
bauble approve EXACT-TRANSFER-ID --approval-digest EXACT-SHA256
bauble recover EXACT-TRANSFER-ID
```

Capture freezes the source, including when approval is missing or declined. Do not edit its workspace while frozen. An optional `--instruction-file path` supplies the exact continuation during capture; without a continuation the destination starts idle. Human interactive `send` and `run` can omit `--prepare` and review the TTY approval dialog. The native `/bauble [host]` flow remains supported. `send --checkpoint path` resumes an already approved checkpoint; it cannot change destination or instruction.

## Message without restarting

Persist a newly generated request UUID before submission. Messages require a fully idle runtime; there is no queue. Text is one quoted literal UTF-8 argument, at most 64 KiB. Shell history and process listings can expose it. Slash commands, templates and `!command` are not expanded.

```sh
bauble message EXACT-ID --request-id REQUEST-UUID -- 'Literal instruction'
bauble message-status EXACT-ID --request-id REQUEST-UUID
```

`accepted` means native acceptance only. `uncertain` means query the **same** UUID; never resend or choose a new UUID to bypass uncertainty. `absent` is not proof a delayed request cannot arrive. A rejected UUID is terminal; a new submission needs explicit authorization.

## Return results and reopen

Quiesce remote writers first. Return capture freezes the remote source and downloads a reverse snapshot; it does not overwrite your original checkout.

```sh
bauble pull ORIGINAL-ID --prepare
bauble inspect REVERSE-ID
bauble approve REVERSE-ID --approval-digest REVERSE-SHA256
bauble recover REVERSE-ID
# Only after confirmed return and old-runtime exit, use the printed exact path:
bauble pi --session /absolute/returned/session.jsonl
```

Keep both original and reverse IDs. Recovery uses the existing snapshot and route, never recaptures. Read `bauble docs recovery` on interruption, missing readiness, or authority ambiguity. Never delete locks, ledgers, receipts, or fencing state to force progress.
