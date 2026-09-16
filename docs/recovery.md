# Recovery

Ownership, readiness and observed execution are separate facts. An unreachable host never releases ownership. Missing acknowledgment is not permission to restart, recapture, replay a prompt, or automatically infer task success.

## Inspect before reconciliation

```sh
bauble ls --json
bauble status EXACT-ID --json
bauble status EXACT-ID --refresh --json
bauble inspect EXACT-ID --json
```

Cached status is read-only; refresh observes exact-bound durable remote state only and never rewrites local status. Inspect is sensitive: its manifest includes exact instruction and full inventory. Preserve both original and reverse IDs, checkpoint paths, digest, selected configuration, and state root in any incident report. Do not paste provider payloads or secrets into reports.

## Missing approval

Prepared or noninteractively blocked run/send/pull retains an immutable snapshot. Inspect, obtain authorization, approve its matching digest, then `recover EXACT-ID`. For return use REVERSE-ID. Approve alone does not send, start, restore, fence, or unfreeze. Declining approval leaves any source freeze in place; it is not implicit cancellation.

## Capture intent without a checkpoint

Before live `send` capture, Bauble atomically records `capture-intents/UUID.json`, bound to the exact source registration/lineage/generation, destination alias/root and instruction digest (not instruction text), then emits that UUID on stderr even in JSON/quiet mode. The ID is passed to the runtime; losing its response never selects a replacement ID. The record is evidence only, not approval, a freeze, or transfer authority. Persistence failure sends no capture request.

`status UUID --json` resolves the intent even when the manifest is missing or partial. `observation: "capture-intent"` reports `checkpoint: "missing"` or `"partial-or-invalid"`, the original intent, and recorded owner/registration evidence; it does not infer native process liveness. `recover UUID` then fails `CAPTURE_UNCERTAIN` until a complete exact-bound checkpoint is available. A new capture for that unresolved source generation is blocked. Retain all records and investigate owner/registration/checkpoint bindings; do not recapture, choose a new ID, unfreeze, delete the intent, or infer the process stopped. An explicit status refresh cannot contact a digest-bound checkpoint that is not yet known; it reports local evidence only.

## Interrupted outbound work

`recover EXACT-ID` reconciles existing durable intent. A fresh dispatch intent is never retransmitted automatically. For a frozen session, recovery validates the original snapshot, uploads approved blobs, and performs the fenced protocol. Once fenced, it reconciles the exact destination; an uncertain or activated runtime is never replaced. Changed source files/profile invalidate pre-dispatch safety checks, rather than being silently recaptured.

`recover EXACT-ID --cancel` requires an explicit cancellation request. Before outbound authority it can cancel and unfreeze a session. After authority issuance it requires positive durable destination revocation and proof activation never happened. Fresh jobs with dispatch authority cannot be cancelled by guessing absence. Cancelled snapshots remain as terminal tombstones; approval/recovery cannot reactivate them.

## Interrupted return

`pull ORIGINAL-ID` reuses the durable reverse route; `recover REVERSE-ID` (or the original ID) reconciles it. If capture/download was interrupted, the reverse ID remains stable. Even before the local reverse manifest exists, `status REVERSE-ID` reports the validated original-bound route with `observation: "return-route"` and unknown readiness; `recover REVERSE-ID` reaches the same durable return route. Route-only status (also with `--refresh`) reports local routing evidence, not an unbound remote observation. Once the exact reverse manifest exists locally, resume reuses it rather than recapturing. Downloaded blobs are verified before approval; restoration and remote fencing occur only after exact approval. Restoration uses a separate private local workspace and retains the original checkout unchanged.

After local ownership is confirmed and the old remote runtime exits, explicitly reopen the returned session using the printed `bauble pi --session /absolute/path`. `pull --prepare` refuses an already approved, finalizing, or returned reverse route with `PHASE_CONFLICT` (exit 1). It retains both IDs and suggests observation/recovery, never undoing progress. Repeated unapproved preparation reuses the snapshot and resumes only missing downloads; it verifies current remote durable capture state before reporting a freeze. Return cancellation is not automated. Partial restoration without its durable completion receipt fails closed; do not delete it to retry.

## Messages

Keep the request UUID before submission. `message-status EXACT-ID --request-id REQUEST-UUID` queries without retransmitting. Accepted means native acceptance, not completion. Rejected is terminal for that UUID. Uncertain means retain the UUID and investigate; absent does not prove a delayed request cannot arrive. Never choose a fresh UUID merely to bypass uncertainty or restart an old runtime to gain capability.

## Stop rather than repair by guessing

Do not remove locks, ownership/fencing files, restoration roots, receipts, journals, or message inbox/outbox ledgers. Do not overwrite newer registrations or restart an uncertain Pi process. Corrupt records and configuration drift require explicit investigation. Report IDs and observed durable facts; unknown failures intentionally do not classify safety from arbitrary error text.
