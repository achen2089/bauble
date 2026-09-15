# Automation

Discover the interface with `bauble help`, `bauble help host add`, `bauble docs --list`, and `bauble docs commands`. Help, docs, and version need no configuration, state, credentials, network, or Pi dependency. Save documentation by shell redirect (`bauble docs > manual.md`); docs does not write destination files.

## Authorized preparation workflow

1. Select an exact configured host and registered session/transfer. `sessions` searches registrations in the selected local root only. Names must resolve uniquely; ambiguous matches list candidate UUIDs. There is no newest-session selection or inferred liveness.
2. `run ... --prepare`, `send --session ... --prepare`, or `pull ORIGINAL-ID --prepare` returns durable IDs/digest. Send leaves the source frozen. Pull leaves the remote source frozen and returns original + reverse IDs. No upload/dispatch for prepared run/send; no approval/restoration/fencing for prepared pull.
3. `inspect EXACT-ID --json` is an explicit **sensitive read**: full immutable manifest, exact instruction, files, exclusions, resources, destination and approval digest. Routine summaries omit instruction and provider payloads. Inspect does not load blob contents; the manifest contains their complete immutable inventory and hashes.
4. Obtain user authorization covering that exact snapshot, destination and instruction. `approve EXACT-ID --approval-digest SHA256` **only records approval**. Never compute/supply a digest merely to bypass review.
5. `recover EXACT-ID --json` resumes that snapshot; use REVERSE-ID for return. Never repeat `run` or `send` to recover an existing operation.

JSON never prompts. Missing noninteractive authorization returns exit 3, `APPROVAL_REQUIRED`, and the existing IDs/checkpoint/digest with safe next actions. `--prepare` conflicts with approval/auto-approval; send preparation accepts only `--session`. `--auto-approve` remains an explicitly authorized run/pull-only option, never the default or a recovery suggestion.

## Versioned output migration

Version 0.2.0 replaces previous raw JSON arrays/objects with one finite-command envelope:

```json
{"schemaVersion":1,"command":"sessions","ok":true,"data":{"root":"/state","sessions":[]},"error":null,"nextActions":[]}
```

`data` is an object or null. Lists are named arrays: `transfers`, `sessions`, `hosts`, `topics`. Errors have `code`, `message`, nullable `hint`. Next actions have `description`, an argv array beginning with `bauble`, and effect `read`, `approve`, `mutate`, or `interactive`. Next actions are guidance, never automatic authorization. Message receipt/state/task semantics remain inside `data`. `docs --json` has `topic` and `markdown`; help has `help`; version has `version` and `piVersion`. `open --json` reports only `windowRequested`, not attachment success.

Status contains full ID, kind, host/source/target, phase, ownership, execution, creation/observation timestamp, readiness and observation source. It never infers task success. An observed unknown status is a successful read (exit 0). Interactive `pi`, `attach`, and `open --here` reject JSON before any effects.

Progress is real stage observation on stderr, throttled, without animation; `--quiet` suppresses progress only, not errors or durable recovery IDs. stdout contains exactly one JSON envelope for finite commands. Unknown failures are generic, not guessed safety classifications or raw provider/Zod dumps.

## Follow logs

`log --json` emits one envelope with `transferId`, `sequence`, `text`, `cursor`, `reset`, and `caughtUp`. `log --follow --json` is NDJSON: one envelope per bounded read (including empty caught-up polls), ordered by increasing sequence. Cursor contains file identity and byte offset; reset marks replacement/truncation. Initial read is at most a 256 KiB tail, later reads advance without repeating prefixes, preserving UTF-8 boundaries. Polling waits 1 second when caught up. A terminal failure emits an error envelope; Ctrl-C emits `INTERRUPTED` and exits 130. Consumers must stop on `ok:false`. Logs omit message-reserved content; sensitive native transcripts require separate explicit inspection.

## Exit codes

- 0: successful operation, preparation, or observation (including unknown status).
- 1: ordinary failure, rejected or absent message.
- 2: usage/flag/argument error, rejected before state/network access.
- 3: approval required or mismatched.
- 4: ambiguous delivery or authority; reconcile exact durable IDs, never replay.
- 130: interruption; retain state and IDs.

Error categories are usage, config, capability, target, approval, busy, uncertain; unclassified failures remain `FAILED`. Accepted/idle/window requested never means task done.
