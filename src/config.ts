import { CliError } from './errors.js';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Config, Alias } from './schema.js';
import { atomicWrite, invariant, json, readJson } from './safe.js';
export const configPath = () => process.env.BAUBLE_CONFIG ?? join(homedir(), '.config/bauble/config.json');
export const stateRoot = () => resolve(process.env.BAUBLE_STATE ?? (existsSync(configPath()) ? loadConfig().localRoot : join(homedir(), '.local/state/bauble')));
export function loadConfig(): Config {
  try { return validatedConfig(); } catch (error) { if (error instanceof CliError) throw error; throw new CliError('CONFIG', 'Bauble configuration is missing or invalid.', 'config', 'Read bauble docs configuration; configure explicit absolute roots and a controlled profile.'); }
}
function validatedConfig(): Config {
  invariant(existsSync(configPath()), `Create ${configPath()} with a controlled profile and storage roots before setup; see README`);
  const c = readJson(configPath(), Config);
  invariant(isAbsolute(c.profile) && isAbsolute(c.localRoot) && isAbsolute(c.remoteRoot), 'Configuration paths must be absolute');
  invariant(!c.codeRoot || isAbsolute(c.codeRoot), 'codeRoot must be absolute');
  for (const host of Object.values(c.hosts)) invariant(isAbsolute(host.root) && (!host.codeRoot || isAbsolute(host.codeRoot)), 'Host storage/code roots must be absolute');
  if (c.defaultHost) invariant(c.hosts[c.defaultHost], 'Default host is not configured');
  return c;
}
export function saveConfig(config: Config) { atomicWrite(configPath(), json(Config.parse(config))); }
export function selectHost(config: Config, explicit?: string) { const alias = Alias.parse(explicit ?? config.defaultHost); invariant(config.hosts[alias], `Unconfigured SSH alias: ${alias}`); return alias; }
