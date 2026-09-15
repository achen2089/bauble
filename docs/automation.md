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

Durable transfer/reverse/message request identifiers are synchronously written to stderr before possible channel loss, including `--json --quiet`. These lines contain identifiers and safe checkpoint metadata, never instruction/message text. Keep stderr in the operation record; stdout remains machine-readable.

Progress is real stage observation on stderr, throttled, without animation; `--quiet` suppresses progress only, not errors or durable recovery IDs. stdout contains exactly one JSON envelope for finite commands. Unknown failures are generic, not guessed safety classifications or raw provider/Zod dumps.

## Follow logs

`log --json` emits one envelope with `transferId`, `sequence`, `text`, `cursor`, `reset`, and `caughtUp`. `log --follow --json` is NDJSON: one envelope per bounded read (including empty caught-up polls), ordered by increasing sequence. Cursor contains file identity and byte offset; reset marks replacement/truncation. Initial read is at most a 256 KiB tail, later reads advance without repeating prefixes, preserving UTF-8 boundaries. Polling waits 1 second when caught up. A terminal failure emits an error envelope; Ctrl-C emits `INTERRUPTED` and exits 130. Consumers must stop on `ok:false`. The native producer appends the same serialized/redacted message format without replacing the file, so ordinary messages preserve cursor identity; genuine file replacement/truncation still resets. Reads/appends reject symlink and nonregular targets. Logs omit message-reserved content; sensitive native transcripts require separate explicit inspection.

## Exit codes

- 0: successful operation, preparation, or observation (including unknown status).
- 1: ordinary failure, rejected or absent message.
- 2: usage/flag/argument error, rejected before state/network access.
- 3: approval required or mismatched.
- 4: ambiguous delivery or authority; reconcile exact durable IDs, never replay.
- 130: interruption; retain state and IDs.

Error categories are usage, config, capability, target, approval, busy, uncertain; unclassified failures remain `FAILED`. Accepted/idle/window requested never means task done.

## Offline performance measurements (0.2.0)

On the development Mac, five fresh-process samples from an unrelated cwd/isolated HOME gave median help **29.85 ms**, docs **24.81 ms**, version **23.49 ms**, `ls --json` over **100 transfer records: 63.25 ms**, cached status **53.72 ms**, and empty registered-session discovery **47.02 ms**. The pre-change help median was 669 ms. The first 100-record list sample was 778.71 ms; these are measured medians, not cold-filesystem or CI latency guarantees. Import-denial regressions enforce that discovery/cheap operations do not load Pi/native/checkpoint code.

`test/remote-transfer.test.ts` stages **100 distinct small blobs + one 786,449-byte file** (three 384 KiB-bounded chunks), verifies the destination, then performs five advancing UTF-8 cursor reads. No runtime launches, SSH network, or inference are involved. A dedicated local subprocess measurement:

| Transport | Transfer RPCs | Total RPCs with polls | Helper processes | Transfer time | Five cursor reads |
| --- | ---: | ---: | ---: | ---: | ---: |
| Versioned stream | 105 | 110 | **1** | 3,403 ms | 17 ms |
| Retained one-shot | 105 | 110 | 110 | 9,764 ms | 333 ms |

Both paths use the real helper dispatcher, filesystem validation, and durable blob writes. Poll timings exclude the intentional 1-second caught-up sleep, which separate CLI follow tests exercise. Helper counts, chunk counts, exact cursor text, sequential framing, timeout/loss handling, and no-replay behavior are deterministic assertions; wall time is informational and varies under full-suite concurrency. Actual SSH, GUI, credentials, and host-specific prerequisites still require separately authorized validation; offline results do not certify a host.
