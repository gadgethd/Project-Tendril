import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TendrilError } from './errors.js';
import type { SearchProviderName, TendrilConfig } from './types.js';

const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
const runtimeHome = process.env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `tendril-${process.getuid?.() ?? 'user'}`);

export const DEFAULT_CONFIG: TendrilConfig = {
  host: '127.0.0.1',
  port: 3210,
  headless: true,
  maxSessions: 4,
  sessionIdleMs: 10 * 60_000,
  actionTimeoutMs: 30_000,
  navigationTimeoutMs: 60_000,
  maxSnapshotChars: 20_000,
  maxResponseBodyBytes: 2 * 1024 * 1024,
  blockPrivateNetworks: true,
  allowedHosts: [],
  blockedHosts: [],
  workspaceRoots: [process.cwd()],
  searchProviders: ['bing', 'duckduckgo', 'google'],
  dataDir: path.join(dataHome, 'project-tendril'),
  runtimeDir: runtimeHome,
  logLevel: 'info',
};

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new TendrilError('CONFIGURATION_ERROR', `Invalid boolean value: ${value}`);
}

function envNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TendrilError('CONFIGURATION_ERROR', `${name} must be a non-negative number`);
  return parsed;
}

function envList(value: string | undefined): string[] | undefined {
  return value?.split(',').map((item) => item.trim()).filter(Boolean);
}

export async function loadConfig(options: { configPath?: string; overrides?: Partial<TendrilConfig> } = {}): Promise<TendrilConfig> {
  const defaultPath = path.join(process.cwd(), 'tendril.config.json');
  const configPath = options.configPath ?? process.env.TENDRIL_CONFIG ?? defaultPath;
  let fileConfig: Partial<TendrilConfig> = {};
  try {
    fileConfig = JSON.parse(await readFile(configPath, 'utf8')) as Partial<TendrilConfig>;
  } catch (error) {
    if (options.configPath || process.env.TENDRIL_CONFIG) {
      throw new TendrilError('CONFIGURATION_ERROR', `Unable to read configuration at ${configPath}`, { cause: error });
    }
  }

  const envConfig: Partial<TendrilConfig> = {};
  const set = <K extends keyof TendrilConfig>(key: K, value: TendrilConfig[K] | undefined): void => {
    if (value !== undefined) envConfig[key] = value;
  };
  set('host', process.env.TENDRIL_HOST);
  set('port', envNumber(process.env.TENDRIL_PORT, 'TENDRIL_PORT'));
  set('headless', envBoolean(process.env.TENDRIL_HEADLESS));
  set('executablePath', process.env.TENDRIL_EXECUTABLE_PATH);
  set('maxSessions', envNumber(process.env.TENDRIL_MAX_SESSIONS, 'TENDRIL_MAX_SESSIONS'));
  set('sessionIdleMs', envNumber(process.env.TENDRIL_SESSION_IDLE_MS, 'TENDRIL_SESSION_IDLE_MS'));
  set('blockPrivateNetworks', envBoolean(process.env.TENDRIL_BLOCK_PRIVATE_NETWORKS));
  set('allowedHosts', envList(process.env.TENDRIL_ALLOWED_HOSTS));
  set('blockedHosts', envList(process.env.TENDRIL_BLOCKED_HOSTS));
  set('workspaceRoots', envList(process.env.TENDRIL_WORKSPACE_ROOTS));
  set('searchProviders', envList(process.env.TENDRIL_SEARCH_PROVIDERS) as SearchProviderName[] | undefined);
  set('searxngUrl', process.env.TENDRIL_SEARXNG_URL);
  set('dataDir', process.env.TENDRIL_DATA_DIR);
  set('runtimeDir', process.env.TENDRIL_RUNTIME_DIR);
  set('token', process.env.TENDRIL_TOKEN);
  set('logLevel', process.env.TENDRIL_LOG_LEVEL as TendrilConfig['logLevel'] | undefined);

  const config = { ...DEFAULT_CONFIG, ...fileConfig, ...envConfig, ...options.overrides };
  if (!config.host) throw new TendrilError('CONFIGURATION_ERROR', 'host is required');
  if (config.port > 65535) throw new TendrilError('CONFIGURATION_ERROR', 'port must be between 0 and 65535');
  if (config.maxSessions < 1) throw new TendrilError('CONFIGURATION_ERROR', 'maxSessions must be at least 1');
  return config;
}
