import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { usageError } from './errors.js';
import { VERSION, PI_VERSION } from './metadata.js';
interface Command { name: string; usage: string; description: string; flags: string[]; min: number; max: number; example: string }
const c = (name: string, usage: string, description: string, flags: string[], min: number, max: number, example = `bauble ${name}`): Command => ({ name, usage, description, flags, min, max, example });
const inclusion = ['include-sensitive', 'include-history'];
export const commands: Command[] = [
  c('help', '[command…]', 'Show command-specific help without configuration.', [], 0, 2, 'bauble help host add'),
  c('version', '', 'Print Bauble and pinned Pi versions.', [], 0, 0),
  c('docs', '[topic]', 'Print bundled Markdown; no files are generated.', ['list'], 0, 2, 'bauble docs automation'),
  c('host', '', 'Discover explicit SSH host configuration commands.', [], 0, 0, 'bauble host --help'),
  c('host add', '<ssh-alias>', 'Probe an already provisioned host and save its binding; never install software.', ['default', 'profile', 'code-root'], 1, 1, 'bauble host add worker --profile /absolute/profile.json --default'),
  c('host list', '', 'List configured hosts without network access.', [], 0, 0),
  c('host default', '<alias>', 'Select an already configured default host.', [], 1, 1, 'bauble host default worker'),
  c('setup', '<ssh-alias>', 'Explicitly probe and bind a provisioned host (host add alias).', ['default', 'profile', 'code-root'], 1, 1, 'bauble setup worker'),
  c('pi', '', 'Start or explicitly reopen a managed interactive Pi session.', ['session'], 0, 0, 'bauble pi --session /absolute/session.jsonl'),
  c('run', '[folder]', 'Snapshot a fresh literal task; repeating run creates a NEW job.', ['cwd', 'task', 'prompt', 'context', 'host', 'name', 'profile', 'auto-approve', 'prepare', ...inclusion], 0, 1, 'bauble run ./project --task TASK.md --host worker --prepare'),
  c('send', '', 'Freeze and capture one registered session, or send an approved checkpoint.', ['session', 'checkpoint', 'host', 'instruction-file', 'approval-digest', 'prepare', ...inclusion], 0, 0, 'bauble send --session UUID --host worker --prepare'),
  c('sessions', '', 'Read registered sessions in the selected local root only; never infer liveness.', [], 0, 0),
  c('ls', '', 'List cached transfers with concise metadata; no transcript or blob reads.', [], 0, 0),
  c('status', '<id-or-name>', 'Read cached status; refresh observes exact-bound remote durable state only.', ['refresh'], 1, 1, 'bauble status UUID --refresh --json'),
  c('inspect', '<id-or-name>', 'Sensitive read of complete immutable approval inventory and exact instruction.', [], 1, 1, 'bauble inspect UUID --json'),
  c('approve', '<id-or-name>', 'Record exact digest approval only; never capture, start, send, or unfreeze.', ['approval-digest'], 1, 1, 'bauble approve UUID --approval-digest SHA256'),
  c('log', '<id-or-name>', 'Read the runtime log; follow is observational, not proof of task completion.', ['follow'], 1, 1, 'bauble log UUID --follow'),
  c('attach', '<id-or-name>', 'Interactively attach to the exact verified existing runtime.', [], 1, 1, 'bauble attach UUID'),
  c('open', '<id-or-name>', 'Request a macOS Terminal window, or attach here; never launch Pi.', ['here'], 1, 1, 'bauble open UUID'),
  c('message', '<id-or-name> <literal-text>', 'Submit one literal message to an idle runtime; accepted is not task success.', ['request-id'], 2, 2, 'bauble message UUID --request-id REQUEST-UUID -- "Literal instruction"'),
  c('message-status', '<id-or-name>', 'Reconcile an exact request UUID without retransmitting.', ['request-id'], 1, 1, 'bauble message-status UUID --request-id REQUEST-UUID'),
  c('pull', '<id-or-name>', 'Freeze/capture remote results for a separate private local restoration.', ['approval-digest', 'auto-approve', 'prepare'], 1, 1, 'bauble pull UUID --prepare'),
  c('recover', '<id-or-name>', 'Reconcile the same immutable snapshot and durable authority; never restart.', ['approval-digest', 'cancel'], 1, 1, 'bauble recover UUID'),
];
const strings = new Set(['cwd', 'task', 'prompt', 'context', 'name', 'profile', 'code-root', 'session', 'host', 'checkpoint', 'instruction-file', 'approval-digest', 'include-sensitive', 'include-history', 'request-id', 'root']);
const multiples = new Set(['context', ...inclusion]);
const globals = ['help', 'json', 'quiet'];
export type Values = Record<string, string | boolean | string[] | undefined>;
export interface Parsed { command: string; args: string[]; values: Values; help: boolean; internal: boolean }
function parse(args: string[], flags: string[]) {
  const options: ParseArgsOptionsConfig = {};
  for (const flag of flags) options[flag] = { type: strings.has(flag) ? 'string' : 'boolean', ...(multiples.has(flag) ? { multiple: true } : {}), ...(flag === 'help' ? { short: 'h' } : {}), ...(flag === 'version' ? { short: 'V' } : {}) };
  try {
    const result = parseArgs({ args, options, strict: true, allowPositionals: true, tokens: true });
    const seen = new Set<string>();
    for (const token of result.tokens) if (token.kind === 'option') { if (seen.has(token.name) && !multiples.has(token.name)) usageError(`Duplicate --${token.name}.`); seen.add(token.name); }
    return result;
  } catch { return usageError('Unknown/duplicate flag, missing flag value, or invalid argument.'); }
}
export function parseCommand(argv: string[]): Parsed {
  // This preliminary strict vocabulary pass is pure; the selected command is then parsed against its own flags.
  const preliminary = parse(argv, [...new Set([...globals, 'version', 'root', ...commands.flatMap(c => c.flags)])]);
  const positions = preliminary.positionals; let name = positions[0] ?? 'help'; let consumed = positions.length ? 1 : 0;
  if (preliminary.values.version) { if (positions.length) usageError('--version cannot be combined with a command.'); name = 'version'; }
  if (name === 'host' && positions[1]) { name += ' ' + positions[1]; consumed = 2; }
  const internal = ['_helper', '_runtime', '_open', '_attach'].includes(name);
  const spec = commands.find(c => c.name === name);
  if (!spec && !internal) usageError(`Unknown command ${name}. Try bauble help; no command was executed.`);
  const flags = internal ? (name === '_runtime' ? ['root'] : []) : spec!.flags;
  const parsed = parse(argv, [...globals, ...(name === 'version' ? ['version'] : []), ...flags]);
  const args = parsed.positionals.slice(consumed); const v = parsed.values as Values;
  const help = Boolean(v.help);
  if (internal && (v.json || v.help || v.quiet)) usageError('Internal commands do not accept public rendering flags.');
  if (!help && spec && (args.length < spec.min || args.length > spec.max)) usageError(`Usage: bauble ${spec.name} ${spec.usage}`);
  if (help && spec && args.length > spec.max) usageError('Unexpected positional arguments.');
  if (name === 'help' || name === 'docs') { const topic = args.join(' '); if (name === 'help' && topic && !commands.some(c => c.name === topic)) usageError(`Unknown help command ${topic}.`); }
  if (!help && !internal) {
    if (v.json && (name === 'pi' || name === 'attach' || (name === 'open' && v.here))) usageError('Interactive commands do not support --json.');
    if (v.prepare && (v['approval-digest'] || v['auto-approve'])) usageError('--prepare conflicts with approval and auto-approval.');
    if (name === 'run') { if (Boolean(v.task) === Boolean(v.prompt)) usageError('run requires exactly one --task or --prompt.'); if (args[0] && v.cwd) usageError('Choose positional folder OR --cwd.'); }
    if (name === 'send') { if (Boolean(v.session) === Boolean(v.checkpoint)) usageError('send requires exactly one --session or --checkpoint.'); if (v.checkpoint && (v.prepare || v.host || v['instruction-file'] || v['approval-digest'] || inclusion.some(f => v[f]))) usageError('An existing checkpoint retains its exact destination, inventory, instruction and approval.'); }
    if ((name === 'approve' && !v['approval-digest']) || (name === 'message-status' && !v['request-id'])) usageError(`Missing required ${name === 'approve' ? '--approval-digest' : '--request-id'}.`);
    if (name === 'recover' && v.cancel && v['approval-digest']) usageError('--cancel conflicts with --approval-digest.');
    for (const alias of [v.host, v.name, ...(['host add', 'host default', 'setup'].includes(name) ? [args[0]] : [])]) if (alias !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(String(alias))) usageError('Host aliases and names must use 1–128 alphanumeric, dot, underscore or hyphen characters, starting alphanumeric.');
    if (v['approval-digest'] && !/^[a-f0-9]{64}$/.test(String(v['approval-digest']))) usageError('--approval-digest requires lowercase SHA256.');
    if (v['request-id'] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v['request-id']))) usageError('--request-id requires a UUID.');
    if (name === 'message' && (!args[1] || Buffer.byteLength(args[1]) > 65536 || args[1].includes('\0'))) usageError('Message requires one nonempty literal UTF-8 argument, at most 64 KiB.');
    if (name === 'docs' && v.list && args.length) usageError('docs --list takes no topic.');
  }
  return { command: name, args, values: v, help, internal };
}
export function helpText(name?: string) {
  const spec = commands.find(c => c.name === name);
  if (!spec || name === 'help') return `Bauble ${VERSION} — native Pi ${PI_VERSION}\n\n${commands.map(c => `  ${c.name.padEnd(16)} ${c.description}`).join('\n')}\n\nUse bauble help <command> or bauble docs. No newest-session selection; no --yes.`;
  return `Usage: bauble ${spec.name} ${spec.usage}\n${spec.description}${name === 'host' ? '\n\nSubcommands:\n' + commands.filter(c => c.name.startsWith('host ')).map(c => `  ${c.name} ${c.usage} — ${c.description}`).join('\n') : ''}\n\nFlags: ${[...spec.flags, ...globals].map(f => '--' + f + (strings.has(f) ? ' <value>' : '') + (multiples.has(f) ? ' (repeatable)' : '')).join(', ')}\n\nExample: ${spec.example}\nManual: bauble docs ${spec.name}`;
}
export function commandMarkdown(name?: string) { const list = name ? commands.filter(c => c.name === name) : commands; return list.map(c => `## ${c.name}\n\n${c.description}\n\n\`\`\`text\n${helpText(c.name)}\n\`\`\`\n`).join('\n'); }
