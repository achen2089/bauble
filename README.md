# Bauble

**Run a fresh Pi task remotely—or move a native session there and bring it back.**

Bauble launches an approved task with a snapshot of your Git repo or plain folder, without a local assistant bootstrap. It also checkpoints existing native conversations and explicitly declared resources for ownership handoff over SSH. Attach to the existing remote terminal, send it an instruction, or pull results into a separate local workspace without overwriting your original source.

- **Keep context:** preserve native session history, branches, and supported compactions.
- **Review before sending:** approve an inventory bound to the exact checkpoint and destination.
- **Hand off ownership:** cooperative fencing prevents managed runtimes from working as competing owners.
- **Return safely:** restore into a private repository rather than merge over newer local edits.

> **Pre-release:** offline tests are included, but live SSH integration must pass on each intended host before you trust a handoff. The full v1 acceptance plan is not yet satisfied. See [Limits](#limits) and [Verification](#verification). Cooperative fencing is not a security sandbox.

## Contents

- [Install and configure](#install-and-configure)
- [Bauble skill](#bauble-skill)
- [Fresh remote tasks](#fresh-remote-tasks)
- [Native Pi and transfer](#native-pi-and-transfer)
- [Message the existing Pi](#message-the-existing-pi)
- [Persistence and recovery](#persistence-and-recovery)
- [Limits](#limits)
- [Verification](#verification)

## Install and configure

### Requirements

- Node.js **>=22.19.0** and Git on each machine.
- The exact `@earendil-works/pi-{coding-agent,ai,tui}` **0.85.1** dependencies (installed by `npm ci`).
- Linux and **tmux >=3.2** on remote destinations, reachable through configured SSH aliases.
- Pi credentials configured independently on each execution machine (fresh remote tasks need no local inference credentials).

### Install

On each machine, manually install Bauble on the **non-interactive SSH PATH**:

```sh
npm ci
npm run check
npm run build
npm install --global .
```

Setup never installs packages, provisions hosts, transfers credentials, or modifies SSH/tmux settings. Credentials are configured independently with Pi on each machine. Bauble reads local Pi authentication; no auth file or credential value is checkpointed. Trust the destination with **all** included history and transcripts.

### Configure

Create `~/.config/bauble/config.json` (or set `BAUBLE_CONFIG`). All paths must be absolute. There are **no built-in hosts or model defaults**. Replace the example paths and explicitly select your provider/model in the profile before use:

```json
{
  "version": 1,
  "hosts": {},
  "profile": "/absolute/path/profile.json",
  "localRoot": "/absolute/path/bauble-state",
  "remoteRoot": "/absolute/remote/path/bauble-state"
}
```

On the destination, its own `remoteRoot` must match that destination's configured storage. A remote profile with the same policy and ordered resource contents must already exist. Existing configuration/profile locations are never inferred from an unmanaged Pi runtime. First local bootstrap is described below.

Profile shape (the capitalized provider/model strings are placeholders to replace, **not defaults**):

```json
{
  "version": 1,
  "policy": "bauble-pi-v1",
  "provider": "SELECT_PROVIDER",
  "model": "SELECT_EXACT_MODEL_ID",
  "thinking": "off",
  "tools": ["read", "bash", "edit", "write"],
  "instructions": [],
  "skills": [],
  "prompts": [],
  "executables": [],
  "services": [],
  "settings": { "compaction": { "enabled": true } },
  "testOnly": false
}
```

Resources are explicit files/directories relative to the profile file or absolute paths. Declare each skill's **complete directory**, including helper files. Unknown profile settings/extensions are rejected. Supported non-secret settings are compaction, retry, and image policy; see `src/schema.ts`. Executables are names on PATH; services declare `{ "name": "...", "host": "...", "port": 1234 }`. These are checked, never provisioned.

Run `bauble host add <ssh-alias>` (or `bauble setup <ssh-alias>`) for each destination. The first successfully validated host becomes default; `--default` changes it. Hosts are interchangeable destinations, not a migration chain. Personal host selection is configuration data; this repository does not modify your personal configuration. State defaults to `~/.local/state/bauble`, or configured `localRoot`; `BAUBLE_STATE` overrides it for isolation.

## Bauble skill

The bundled [Bauble skill](skills/bauble/SKILL.md) teaches an agent how to configure hosts, launch approved fresh tasks, select an explicit session for handoff, message an existing runtime, and recover without replaying uncertain work. It is guidance—not a replacement for the CLI, host setup, or checkpoint approval.

For ordinary Pi sessions, copy the skill from this repository into your user skill directory (check for an existing directory or symlink first):

```sh
mkdir -p ~/.pi/agent/skills
cp -R skills/bauble ~/.pi/agent/skills/bauble
```

Start a new Pi session, then invoke it explicitly:

```text
/skill:bauble help me hand off this session to my configured SSH host
```

**Managed `bauble pi` sessions do not load global skills.** Add the complete skill directory to the controlled profile's `skills` array, preserving any existing entries:

```json
"skills": ["/absolute/path/to/bauble/skills/bauble"]
```

Configure the matching skill contents in the destination profile before launching a managed session. Changing a profile after launch invalidates checkpoint eligibility. The skill is also included in the npm package under `skills/bauble`.

`/skill:bauble` loads agent guidance; `/bauble [host]` opens the native transfer approval dialog. Skill commands sent through `bauble message` or a continuation instruction remain literal text and are not expanded.

## Fresh remote tasks

After installing/configuring the destination independently, configure it once:

```sh
bauble host add my-server --default --profile /absolute/path/profile.json
bauble host list
bauble host default my-server
# Optional: authorize an existing private code directory on this destination.
bauble setup my-server --code-root /absolute/remote/code
```

`host add` runs the same compatibility/profile/credential/requirement checks as `setup`. An existing config and profile are retained. On the **first local configuration only**, `--profile` selects an explicit controlled profile; otherwise Bauble can seed a minimal builtins-only profile from ordinary `~/.pi/agent/settings.json`'s saved `defaultProvider`, `defaultModel`, and per-model/default thinking selection. All three must exist and match a supported pinned model/thinking level. It prints the complete effective profile and exclusions; it never adopts ambient packages/extensions, project settings, credentials, custom model overrides, skills, or instructions. No local agent session is created. For later `run --profile`, its effective digest must match the configured destination. There are no ad-hoc `--model` or `--thinking` flags.

The destination must already have compatible Bauble, a matching controlled profile, and independently configured credentials. `host add` does not bootstrap a remote profile, install software, or replace remote configuration. `setup --code-root` (also accepted by `host add`) explicitly authorizes **only** that top-level remote config field, backs up the exact previous config to `config.json.<uuid>.bak`, and records it in the local host map. The path must already exist, be canonical, owned by the remote user, not group/world writable, outside a Git repository, and separate from home/state. No SSH/tmux config is edited. Existing top-level `remoteRoot` is preserved and discovered by the helper; hosts can have different state/code roots.

```sh
cd /path/to/project
bauble run --task TASK.md --context CONTEXT.md --auto-approve
bauble run /path/to/plain-folder --host my-server --prompt 'Review these files' --name audit
bauble run --cwd /path/to/repo/subdir --task TASK.md --context docs --context notes.md --auto-approve
bauble ls
bauble open audit --here
bauble message audit 'Continue with the tests' --request-id <uuid>
bauble log audit --follow
bauble pull audit                  # approve the exact result snapshot interactively
bauble pull <job-id> --auto-approve # explicit approval of this captured result only
```

The workspace defaults to the current directory. A positional folder and `--cwd` are alternatives. Task/context paths resolve from the invoking directory, not from `--cwd`. Exactly one `--task` or `--prompt` is required. Task/context files are bounded literal UTF-8 without NUL; context directories include safe regular text files under the same exclusions, not symlinks. The combined literal instruction is limited to 1 MiB (large inventories can additionally hit the 2 MiB protocol bound). Explicit task/context snapshots are independently stored under the run's `inputs/`, separate from the writable workspace. Context contents are appended as literal JSON data with their snapshot paths. Markdown frontmatter, slash commands, shell-looking text, and hooks are **not executed or expanded by Bauble**. The model may of course act on an approved instruction through its ordinary tools; this is not a sandbox.

`--auto-approve` is an explicit opt-in for **this immutable job's transfer and literal task execution**, not a general `--yes`, secret-validation bypass, or unsupported harness permission flag. The full inventory, digest, target/cwd mappings, effective profile, requirements, exclusions and exact task/context are printed before approval; `autoapproval.json` durably binds it to that job/digest/destination. Without it, a TTY and exact digest approval are required; non-TTY invocation refuses before any dispatch. The controlled native tools already run with the destination user's OS permissions. Use an independently isolated account/container for unattended untrusted work.

Git mode transfers HEAD-reachable history plus the exact dirty index/worktree, without source stash/commit/reset or index writes. Unsupported/unborn Git repositories fail rather than falling back to folder mode. Nested cwd maps into the captured repository root and is displayed. **Plain folders do not require Git, create a commit, or manufacture HEAD.** They use full file inventories preserving bytes, executable bits and safe internal symlinks. `.gitignore` rules and state/dependency/ambient directories (`.git`, `node_modules`, `.pi`, `.agents`, `.config`, `.cache`, `.local`, `.ssh`, `.aws`, `.gnupg`, `.bauble`) are excluded without traversal. Likely secrets are excluded; credential filenames, escapes/chains, special files, traversal, non-UTF-8 and case-colliding paths are rejected. Explicit sensitive task/context files are rejected even with autoapproval. Canonical project paths are required; home/filesystem-root/state folders cannot be selected. Empty directories, ACLs, xattrs and timestamps are not preserved. Folder `--include-sensitive` is not supported. Quiesce external writers: capture and pre-dispatch consistency checks are not an atomic filesystem snapshot.

A fresh task has its own lineage, immutable ID and dispatch intent, **no local Pi seed, transcript, registration, or source-session fence**. The destination claims launch intent before creating a genuine `SessionManager.create()` native session. Pi itself persists that session when its first assistant activity occurs; Bauble never fabricates an assistant response. Readiness is not task acceptance/completion; `run` returns once the helper reports readiness (or times out unknown), leaving the existing native Pi alive in tmux. A missing/failed readiness receipt exits nonzero. Inspect the terminal/log/native transcript to assess task results; idle never means success.

Retain the printed UUID. Repeating `run` creates a **new task**, not a retry. `bauble recover <uuid>` resumes staging before dispatch intent, but after intent it performs **read-only status reconciliation**, even if activation was never sent. It never replays/restarts an ambiguous launch. `recover --cancel` cancels a fresh job only before dispatch authority exists; afterwards resolve the existing destination, do not delete ledgers. Partial preparation/unknown launches fail closed for manual investigation.

`--name` is an optional safe ASCII handle (`letters/digits/_.-`, first character alphanumeric). UUIDs remain authoritative; duplicate names are allowed but name lookup rejects ambiguity. `ls` shows name/UUID/host/cwd/execution and actual tmux socket/target. Workspaces go under `<codeRoot>/<name>-<uuid>` (or `<codeRoot>/<uuid>`); without `codeRoot`, the existing state-root run layout is retained. Git object storage and native state stay in Bauble state. Each run has an isolated tmux server; ordinary `tmux ls` does **not** list them. `run` prints `tmux -L <socket> attach-session -t <target>` for the destination. Prefer `open <name-or-id> [--here]`, which verifies and attaches the same process, never starts another.

`pull` supports both fresh Git and plain-folder results after real persisted native assistant activity and a settled/clean runtime. It captures the complete result inventory plus genuine native state, with fresh approval, into a **separate local Bauble-owned workspace**, never the original source. Missing files remain absent (no merge), and plain folders stay non-Git. It fences/closes the remote owner using the existing return protocol and prints an explicit local `bauble pi --session ...` command. No automatic merge, cleanup, publication or task-success claim occurs. Closing before Pi has persisted assistant activity cannot produce a native return checkpoint.

**Lifecycle events, not executable hooks:** existing native event names (`agent_start`, `agent_end`, tool/message events) are retained in each destination transfer's `journal.jsonl`; `log` shows the native message log. This slice adds no hook configuration, callback scripts, or document-frontmatter execution. Claude Code and other backends remain future work.

## Native Pi and transfer

### Start locally

After configuring and validating a destination with `bauble setup <ssh-alias>`:

```sh
cd /path/to/committed-git-repo
bauble pi
# Inside that Pi, after real persisted assistant activity: /bauble <ssh-alias>
# To explicitly reopen an existing verified local session instead:
bauble pi --session /absolute/path/to/session.jsonl
```

Migration workflow: start a managed local Pi, do initial work there, then use `/bauble <ssh-alias>` and approve the checkpoint. For a genuinely fresh remote task use `bauble run` below; it does not require local assistant activity. There is no `bauble start` and no arbitrary transcript selection.

This uses Pi's exported runtime, services and native terminal UI with an isolated resource loader. No ambient global/project/package extensions, instructions, skills, templates or settings are enabled. Startup catalog/update/telemetry network activity is disabled; approved inference remains available. Missing credentials, model fallback, unexpected tools or profile changes fail closed.

Explicitly opening a bare JSONL adopts it into the **current** controlled profile; this does not certify its former runtime configuration. A bare file cannot be sent directly. Sessions without complete persisted assistant activity are not transferable.

### Review and send

Inside the running terminal use `/bauble [host]`. The transfer dialog blocks competing terminal input; `j`/`k` scroll the inventory, `y` approves and `n` rejects. Or:

```sh
bauble send --session <registered-path-or-id> --host <ssh-alias>
bauble send --session <registered-path-or-id> --instruction-file continuation.txt
bauble send --checkpoint /absolute/path/to/approved/checkpoint
```

There is no implicit newest-session selection and no `--yes`. The inventory includes working-tree files, index blobs, exclusions, explicit resources, artifacts, requirements, Git history sensitivity, cwd mappings, and exact continuation. Automation must provide the **matching immutable manifest SHA-256** with `--approval-digest`; existing approved checkpoints retain their ID/destination/instruction.

By default ignored and likely-secret untracked files are excluded. `--include-sensitive <path>` explicitly includes an ordinary sensitive/ignored file (repeatable). Tracked sensitive files require inclusion or capture fails. `--include-history <path>` acknowledges sensitive paths reachable in Git history; those historical bytes are **still included** even when a working-tree copy is excluded. Credential-store/SSH-key paths are never allowed. Filenames are a heuristic, not a guarantee that other included bytes are non-secret.

**Quiesce editors, builds, watchers and other external writers.** Capture does not stash, commit, reset, clean, or write the source index. It captures HEAD's self-contained bundle, raw stage-zero index blobs and file inventories, then compares the source again before fencing. It is not an OS-wide atomic filesystem snapshot.

With no instruction the destination is idle in a native Pi terminal. An approved instruction is submitted literally with extension-command/skill/template expansion disabled. An acceptance event means accepted input, **not successful task completion**. Delivery ambiguity is recorded as uncertain and never automatically replayed.

### Observe, attach, and return

```sh
bauble ls --json
bauble log <transfer-id> --follow
bauble open <transfer-id>          # macOS: new native Terminal window
bauble open <transfer-id> --here   # current interactive terminal (including Linux/SSH)
bauble attach <transfer-id>       # compatible current-terminal attachment
bauble pull <transfer-id>
```

`open` and `attach` join **the existing Pi process**; they never launch Pi, change ownership, or replay a prompt. Routing uses the exact durable owner/fence, transfer/digest/generation and readiness receipt—not hostnames. On the destination itself, an owned receipt attaches directly to local tmux, with no remote-map entry required. Without `BAUBLE_STATE`, if the transfer is absent from `localRoot`, Bauble also checks the configured `remoteRoot`. An explicit `BAUBLE_STATE` remains authoritative. Outbound transfers require the configured SSH destination/root and a matching verified helper receipt; the SSH terminal subprocess verifies again before attaching. Install the same current Bauble build on both ends.

On macOS, `open` requests a new Terminal.app window using fixed AppleScript and safely quoted argv. It preserves the effective `BAUBLE_CONFIG` and selected state root even if their paths contain shell characters. The new terminal revalidates the exact receipt and ownership; the launching command reports only a **window request**, not successful attachment. Terminal automation permission and a GUI login may be required. Linux/headless window opening fails with guidance to use `--here`; `--here` requires an interactive terminal (over SSH, allocate a TTY). `attach` retains the current-terminal workflow. Bauble owns a separate tmux server/socket per transfer, not user tmux sessions. Detach with the normal tmux detach key.

Missing, stale, frozen/fenced, returned, closed or non-tmux sessions fail closed. Missing/uncertain readiness requires `bauble recover <transfer-id>`; it is not permission to restart. To reopen a closed remote session, explicitly `pull`, then use the printed `bauble pi --session ...` command after confirmed local ownership. For returned/closed local sessions, explicitly reopen the verified registered path after the old runtime exits. `open` is not a general terminal launcher for bare JSONL or a non-tmux `bauble pi` session.

Pull settles the destination, creates a new checkpoint in the same lineage, reconstructs a separate local private Git repository/worktree or plain folder, fences the remote owner, then prints an explicit `bauble pi --session ...` command. It never modifies the original checkout/newer local edits or automatically sends another prompt.

## Message the existing Pi

```sh
bauble message <transfer-id> 'Literal instruction' --request-id <uuid>
bauble message-status <transfer-id> --request-id <uuid>
# A leading dash in text requires the option terminator:
bauble message <transfer-id> --request-id <uuid> -- '-literal text'
```

A Pi agent can invoke the same CLI. **Use one explicit UUID per intended message and retain it before submission.** Omitting `--request-id` generates a fresh UUID, durably records it and prints it before delivery; repeating a command without the option is a new request, not a retry. Text is one nonempty UTF-8 argument, limited to **64 KiB**, without NUL. Quote for your invoking shell (or pass an argv array); Bauble transports text as JSON data, never as SSH shell interpolation. Helper stdin/control envelopes are bounded to 2 MiB. There is no text-from-stdin mode in this slice.

### Delivery and admission

Routing selects only the exact transfer's local destination owner or configured outbound SSH fence, manifest digest, generation, native session and readiness process receipt (PID/start/nonce). The helper revalidates the live guarded control socket on the destination; no tmux attachment is needed. Missing registration/readiness, stale/frozen/fenced ownership or a closed runtime fails closed. Use `recover` for missing readiness, not an automatic restart. Messaging never launches Pi, reopens the source, changes ownership or searches unmanaged sessions. It uses Bauble's private local socket and SSH helper, with no Intercom or network API server.

Only a **fully idle** runtime admits a message. A guard reservation excludes competing terminal input, mutations and capture from preflight through the settled run. Busy work is neither aborted nor queued. A positive `rejected` result (including `reason: busy`) is terminal for that UUID: wait until fully idle, resolve preflight requirements, then explicitly choose a **new** request ID if you still want delivery. Extension commands, skill commands and prompt templates are disabled; `/bauble`, `/skill:...`, `/template` and `!command` are literal model input, not commands.

### Receipts and retries

Results are JSON with the request ID, text SHA-256, exact process receipt, `state` and `task: not-tracked`:

- `accepted`: Pi's native preflight accepted the input. **Not model completion, a successful task, or proof that any tool ran.** Observe the native terminal/transcript to assess work.
- `rejected`: positive rejection before native acceptance; same-ID retries return this result without delivery.
- `uncertain`: intent exists but acceptance cannot be proved, or the response/control channel was lost. Run `message-status` with the same ID. **Never automatically resend, or use a new ID to bypass uncertainty.**
- `absent`: no destination record was found by a standalone status query. This is not proof a delayed request cannot arrive. Once a client dispatch intent exists, even a missing destination record is reported as `uncertain`.

Both client dispatch intent (`message-outbox/<uuid>.json`) and destination inbox intent (`message-inbox/<uuid>.json`) durably bind UUID, text digest and exact receipt before native delivery. The client also binds the SSH alias/storage root. Same-ID/same-text retries perform read-only reconciliation; they **never retransmit** a previously recorded client intent, even if it crashed before sending. Different text/transfer bindings are rejected. Destination duplicates return the existing receipt; orphaned intent remains uncertain forever unless the original in-flight invocation records its native acknowledgment. There is no transcript-hash guessing, task replay or automatic repair. Status does not change receipts or ownership and can read retained historical receipts after shutdown. Keep these ledgers; deleting them destroys duplicate protection. CLI exit zero means `accepted`, not task success; other delivery states exit nonzero.

### Compatibility and privacy

The existing runtime must advertise **`message-v1`**. Installing a new CLI does not upgrade an already-running Pi: an older runtime/helper produces an explicit capability error. No restart or in-place monkeypatch is attempted. Install the same build on both ends for future launches; any lifecycle change for an old runtime is a separate explicit decision.

Message receipts and CLI diagnostics omit arbitrary message text. `run.log` emits only message-role metadata for runs admitted by this command, including their assistant/tool output; the native transcript still contains the full conversation as usual. Treat it as sensitive. Text passed in argv may also appear in your shell history/process listing. Digests are identifiers, not encryption.

## Persistence and recovery

State contains content-addressed blobs, `lineages/`, `sessions/`, and `transfers/<UUID>/`. Checkpoints contain immutable `manifest.json`, `agent-state/` (unchanged original JSONL plus metadata), `workspace/` (bundle/inventory), and self-contained `blobs/`. Approval is separate and bound to manifest digest/destination. Mutable `status.json`, `journal.jsonl`, and `run.log` are kept separate. Atomic writes use fsync and directory durability barriers. Treat the whole directory, transcript and logs as sensitive.

Ownership: settle/freeze → stage/verify (no Pi start) → durable source fence/generation → destination claim/launch intent → native readiness receipt. Repeating activation never launches twice. A missing receipt means **unknown**, not stopped. Status distinguishes transfer, ownership and observed execution (`starting`, `running`, `idle`, `waiting_for_input`, `exited`, `failed`, `unknown`). Idle is not task success. No tool replay, automatic merge, or automatic agent restart.

```sh
bauble recover <transfer-id>
bauble recover <transfer-id> --cancel
```

Recovery reconciles an outbound transfer's existing receipt, resumes safe staging even if the destination never received the manifest, or resends authority for the same ready/fenced transfer ID. Cancelled transfers are rejected before any authority RPC; recovery requires the exact approved transfer/digest/generation under the lineage lock. Before authority is issued a captured/approved checkpoint can be cancelled locally. After authority issuance, cancellation requires a **positive durable destination revocation** and proof activation never happened. Activated/ambiguous launches cannot be cancelled; use pull or resolve the ambiguity. An unreachable host never releases ownership. Tombstones, checkpoints and receipts are retained; no automatic destructive cleanup.

### Interrupted returns

`pull` prints and durably records a reverse recovery ID before contacting the remote source. Repeat `pull <original-id>` or `recover <reverse-id>` (also accepted: the original ID) to resume that same return. `returns/<reverse-id>.json` binds the original and reverse IDs/digests to the configured host and storage roots. Lost capture acknowledgments reuse the existing remote checkpoint; they never generate another ID or unfreeze an earlier capture. Approval remains bound to the reverse manifest; unattended recovery can supply its exact `--approval-digest`.

Restoration writes a digest-bound completion receipt only after flushing the materialized files/directories. Recovery validates and reuses that completed workspace, native session, resources and artifacts. It re-obtains an exact positive remote fencing receipt before local ownership release, then idempotently records the local claim, registration and returned status. A lost finish acknowledgment is retried separately. Recovery never launches Pi, sends input, or overwrites a subsequently opened registration. Keep the original fenced runtime closed before completing local ownership release.

### Crash recovery limits

An orphaned runtime/lineage lock is intentionally not auto-removed. Investigate recorded PID/start identity, owner generation, receipts, native files, and destination revocation before any manual state repair. Partial restoration roots without a completion receipt, changed restored bytes, publication interrupted before capture-owner binding, and registrations opened before returned-status persistence fail closed for manual inspection; nothing is automatically deleted or rebuilt. Return cancellation is not automated: `recover --cancel` rejects a pending return rather than guessing remote ownership. Do not delete fencing files to force a start. Missing source clean-shutdown metadata blocks offline send. A failed capture before an immutable checkpoint exists safely unfreezes only the unchanged owner acquired by that capture; publication or a changed binding retains the freeze.

## Limits

- **Pinned SDK discrepancy:** Pi 0.85.1's shipped documentation describes `retainedTail` compactions, but its actual native context builder only honors `firstKeptEntryId`. Bauble rejects any `retainedTail` checkpoint before approval/fencing. A regression proves the native limitation. The plan's both-compaction-format acceptance item remains blocked; no synthetic context or Pi patch is used.
- Native restore uses `SessionManager.forkFrom()`, preserves the complete entry tree, branches to the captured leaf, and appends one deterministic relocation message as its child. Native IDs and transferred lineage IDs are distinct. Restart reproduces that position. Managed tree selections update durable metadata. Historical tool output/prose paths are not rewritten. Known `fullOutputPath` artifacts are required and mapped in relocation metadata; arbitrary prose paths are not automatically moved.
- In-process `/new`, `/resume`, `/fork`, `/clone`, and `/import` are explicitly disabled in the controlled runtime. Start a separate explicit `bauble pi` invocation instead. Reload reuses the isolated loader; profile changes invalidate checkpoint eligibility. Model/thinking changes must match the selected profile before capture.
- Fencing is **cooperative**, version-pinned host guards on public SDK instances plus extension input/bash/tool/mutation guards. Handler/storage failures block work. Manually running unmodified Pi, malicious tools/extensions, direct filesystem changes or state tampering can bypass it. This is not a sandbox against the session owner.
- No unmanaged linked worktrees, submodules, LFS pointers/filters, sparse/shallow/partial repositories, alternates, unresolved Git operations, conflicted/nonstandard index flags, case-colliding paths, special files, symlink escapes/chains or non-UTF-8 paths. Bauble-owned linked worktrees are supported. File bytes, executable bits and safe symlinks are preserved; ACLs, xattrs, timestamps and empty directories are not promised.
- Each blob/file is limited to 64 MiB; structured SSH messages are bounded to 2 MiB and chunks to 384 KiB. Oversized inventories fail rather than transfer partially without approval. Interrupted staging reuses verified complete blobs; partial blobs restart at offset zero.
- No automatic provisioning, scheduler, dashboard, cross-harness conversion, multi-agent orchestration, migration chains or merging.

## Verification

```sh
npm ci
npm run check
npm run test:roundtrip
BAUBLE_TEST_SSH_HOST=<configured-alias> npm run test:ssh
```

The SSH environment value authorizes isolated fixtures on **that** configured host. Without it, or missing prerequisites, the SSH gate exits nonzero—never silently skips. It requires an already-installed compatible remote Bauble and configuration. The fixture provider is credential-free and test-only; normal `bauble pi` rejects test profiles unless `BAUBLE_TEST_MODE=1` is explicitly set.

Offline messaging tests use actual pinned native acceptance with a credential-free deterministic provider, real local control sockets/CLI subprocesses, and an in-process SSH-helper seam. They cover literal registered commands/skills/templates, native write tools, ACK-before-completion, lost acknowledgments, duplicate/concurrent submission, busy/input/auth/compaction preflight races, frozen/stale/missing bindings, late delivery, orphaned intent, receipt persistence failure, old capabilities, bounded malicious input and fragmented framing. They do not send prompts to user sessions or paid inference. Live SSH messaging and native interactive-terminal races still require host validation; these fixtures are not exhaustive crash/power-loss testing.

Offline checks require local tmux for an isolated attachment fixture. Open regressions cover local/SSH routing, exact receipt/fence/process bindings, no launch or prompt replay, current-terminal requirements, headless errors, terminal subprocess revalidation, and hostile config/state path quoting. The macOS GUI launch is tested through an argv seam, not a live Terminal automation gate; live GUI/SSH `open` still needs validation on intended hosts.

Offline tests use the real pinned Pi loader/context builder/runtime and real tools, preserving branch trees, compaction, tool history, labels/state, embedded attachments, artifact mappings, exact dirty index/worktree bytes and newer original-checkout edits. Protocol tests cover real continuation, duplicate activation and lost acknowledgments. Recovery regressions cover stale/cancelled transfers across two destinations, empty-destination staging, duplicate/failed capture, lost return capture/fence/finish acknowledgments, and injected interruption after capture, completed restoration, fencing, claim, registration, returned status and finish. They assert no additional runtime start, no prompt replay, preserved newer original-checkout edits, and fail-closed partial/changed restoration and stale ownership. These are bounded exception-injection tests, not exhaustive power-loss testing. The SSH gate exercises actual SSH, native Pi, two attach/detach cycles with identical process receipt/tmux target, duplicate start prevention, outbound acknowledgment recovery and interrupted-return fence acknowledgment recovery through the shared recovery implementation. It verifies exactly one literal native continuation and successful write-tool result, clean local return registration, restart-persistent leaf, and idempotent completion. Fixtures are unique and retained for investigation; no user sessions are used. Exhaustive crash-transition and native TUI shortcut testing remain outstanding; offline results do not certify live host behavior.

Fresh-run regressions use the public non-TTY CLI through an isolated SSH argv seam, a real native Pi/tmux process and deterministic write tool, plus direct helper tests for exact dirty Git/plain-folder returns, no local seed, literal snapshots, source consistency, explicit codeRoot config backup, names/default hosts, messages/open, and lost/pre-send launch acknowledgments without replay. The probe is fixture-controlled; these are **not live Linux SSH acceptance results**.

## CLI manual and automation (0.2.0)

Start with `bauble docs quickstart`; use `bauble docs commands`, `bauble docs automation`, `bauble docs configuration`, and `bauble docs recovery` for the bundled manual. `bauble help <command>` describes strict command-specific flags; `bauble docs --list` lists topics. Save Markdown with `bauble docs > manual.md`.

For agent-authorized workflows use prepare → inspect → authorized approve → recover the exact ID (reverse ID for returns). `sessions`, `status`, and `inspect` are read-only. JSON now uses a schemaVersion 1 envelope instead of the older raw JSON data; see the automation topic for payloads and exit codes. Both ends need Bauble 0.2.0; Pi remains 0.85.1. Installing this build is an explicit separate step, not part of setup or testing.
