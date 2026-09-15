import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Alias, Profile } from './schema.js';
import { configPath, loadConfig, saveConfig } from './config.js';
import { atomicWrite, invariant, json, readBytes } from './safe.js';
import { readProfile, validateModel } from './pi/profile.js';
import { hasGit } from './workspace.js';


export async function bootstrapConfig(profileInput?: string) {
  if (existsSync(configPath())) { invariant(!profileInput || resolve(profileInput) === loadConfig().profile, 'Existing config profile is unchanged; configure matching profiles explicitly'); return; }
  const root = join(homedir(), '.local/state/bauble'); let profilePath: string;
  if (profileInput) { profilePath = resolve(profileInput); readProfile(profilePath); }
  else {
    const settingsPath = join(homedir(), '.pi/agent/settings.json'); invariant(existsSync(settingsPath), 'First setup requires --profile path or ordinary Pi defaultProvider/defaultModel/defaultThinkingLevel');
    const settings = JSON.parse(readBytes(settingsPath).toString()) as Record<string, unknown>;
    const provider = settings.defaultProvider; const model = settings.defaultModel;
    const perModel = settings.modelThinkingLevels as Record<string, unknown> | undefined;
    const profile = Profile.parse({ version: 1, policy: 'bauble-pi-v1', provider, model, thinking: perModel?.[`${provider}/${model}`] ?? settings.defaultThinkingLevel, tools: ['read', 'bash', 'edit', 'write'], instructions: [], skills: [], prompts: [], executables: [], services: [], settings: { compaction: { enabled: true } }, testOnly: false });
    await validateModel(profile, process.env.BAUBLE_STATE ?? root);
    profilePath = join(dirname(configPath()), 'profile.json'); invariant(!existsSync(profilePath), 'Refusing to overwrite existing profile.json; supply --profile'); atomicWrite(profilePath, json(profile));
  }
  readProfile(profilePath);
  saveConfig({ version: 1, hosts: {}, profile: profilePath, localRoot: root, remoteRoot: root });
}
export function validateCodeRoot(path: string, state: string) {
  invariant(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path, 'codeRoot must be an existing canonical absolute directory, without symlink ancestors');
  invariant(!hasGit(path), 'codeRoot cannot be inside a Git repository; select a separate parent code directory');
  const stat = lstatSync(path); invariant(stat.isDirectory() && stat.uid === process.getuid?.() && !(stat.mode & 0o022), 'codeRoot must be owned by this user and not group/world writable');
  invariant(path !== '/' && path !== homedir() && path !== state && !state.startsWith(path + '/') && !path.startsWith(state + '/'), 'codeRoot must be a separate code folder, not home or Bauble state'); return path;
}
export function configureCodeRoot(path: string) {
  const config = loadConfig(); validateCodeRoot(path, config.remoteRoot);
  const backup = `${configPath()}.${randomUUID()}.bak`; atomicWrite(backup, readBytes(configPath()));
  saveConfig({ ...config, codeRoot: path }); return { codeRoot: path, backup };
}
export async function hostCommand(action: string, alias?: string, options: { makeDefault?: boolean; profile?: string; codeRoot?: string } = {}) {
  if (action === 'add') { invariant(alias, 'host add requires SSH alias'); Alias.parse(alias); await bootstrapConfig(options.profile); return (await import('./commands.js')).setup(alias, options.makeDefault ?? false, options.codeRoot); }
  const config = loadConfig(); invariant(!options.profile && !options.codeRoot && !options.makeDefault, 'host list/default do not accept setup options');
  if (action === 'list') { invariant(!alias, 'host list takes no alias'); return { defaultHost: config.defaultHost ?? null, hosts: Object.entries(config.hosts).map(([alias, host]) => ({ alias, ...host })) }; }
  invariant(action === 'default' && alias && config.hosts[Alias.parse(alias)], 'Use host add <alias>, host list, or host default <configured-alias>');
  saveConfig({ ...config, defaultHost: alias }); return { defaultHost: alias };
}
