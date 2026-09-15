# Configuration

Bauble reads `BAUBLE_CONFIG`, otherwise `~/.config/bauble/config.json`. `BAUBLE_STATE` explicitly selects local state; otherwise config `localRoot` is used, with the standard `~/.local/state/bauble` fallback for unconfigured read-only discovery. Missing state lists empty; corrupt records fail explicitly, not silently disappear. Read-only queries do not create or chmod state.

```json
{
  "version": 1,
  "profile": "/absolute/profile.json",
  "localRoot": "/absolute/local-state",
  "remoteRoot": "/absolute/remote-state",
  "hosts": {}
}
```

All paths are absolute. The helper accepts only its configured remote root (or explicitly authorized isolated UUID test fixtures). `host add`/`setup` probes existing software and matching profile digest, then records the SSH alias/root/profile binding. `host default ALIAS` selects an existing host. `host list` is local-only. Optional `codeRoot` is a separate existing canonical user-owned directory, not home, state, or a Git checkout, and not group/world writable. Changing remote storage or code-root bindings can intentionally prevent old transfers from proceeding; investigate rather than rewriting immutable manifests.

First setup accepts `--profile /absolute/profile.json`; without it, it can derive a controlled profile from ordinary Pi default provider/model/thinking settings. This does not copy ambient extensions, packages, resources, overrides, or credentials. Configure the same controlled profile independently at the destination. Example profile:

```json
{
  "version": 1,
  "policy": "bauble-pi-v1",
  "provider": "YOUR_PROVIDER",
  "model": "YOUR_MODEL",
  "thinking": "off",
  "tools": ["read", "bash", "edit", "write"],
  "instructions": [],
  "skills": [],
  "prompts": [],
  "executables": [],
  "services": [],
  "settings": {"compaction": {"enabled": true}},
  "testOnly": false
}
```

Use valid provider/model/thinking values for the pinned Pi catalog. Profile resources and requirements are explicitly inventoried. Skills are complete directories; ambient packages/hooks/extensions are not loaded. Credentials remain local to each machine; Bauble never copies auth stores or SSH keys. Secret-name exclusions are heuristic. `--include-sensitive path` and `--include-history path` require explicit informed consent; forbidden credential/key material cannot be authorized for transfer.

Both ends need the current Bauble 0.2.0 build for this CLI release. Pi remains exactly 0.85.1; persisted checkpoint/protocol/owner schemas remain compatible, with no migrations. Installing this source build is a separate user deployment decision. Do not replace a globally installed CLI, configure credentials, or provision a host as a side effect of using help/docs/tests.

## Remote transport

Each finite remote command opens at most one SSH/helper connection per host, shared by setup, upload/download, recovery, and message preflight/delivery. Log follow reuses its connection until completion, error, or interruption. Connections are command-scoped, not a daemon or cross-command cache. Interactive terminal attachment is a separate SSH terminal channel, not another RPC helper.

The new client requires an exact compatible release and `rpc-stream-v1` capability handshake **before any remote operation**. Frames use stream protocol 1, strict UTF-8 NDJSON, sequential positive IDs and matching response IDs, bounded to 2 MiB each; blobs retain 384 KiB chunks. Output uses backpressure rather than an unbounded response queue. Configuration is reloaded and configured storage authorization checked on every helper request, including after setup changes codeRoot; immutable operation bindings remain enforced. SSH connect timeout is 10 seconds; handshake/request timeout is 120 seconds.

Incompatibility reports `STREAM_CAPABILITY` with a matching-build upgrade instruction. There is no downgrade to the retained old one-shot helper, reconnect, or automatic retransmission. Channel loss fails the connection closed; keep durable IDs and reconcile explicitly. Losing the helper/client channel cannot cancel input already admitted by the existing native process. Closing a connection never deletes checkpoint/ownership/message state. Library users of the callable SSH RPC seam must explicitly close their command-owned connection.
