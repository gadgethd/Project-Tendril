import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v4';
import { TendrilError } from './errors.js';
import type { BrowserBackend, SearchProviderName, TendrilConfig } from './types.js';

interface PlatformPaths {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  temporaryDirectory?: string;
  userIdentity?: string | number;
}

export function defaultDataDirectory(options: PlatformPaths = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local'), 'Project Tendril');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Project Tendril');
  return path.posix.join(env.XDG_DATA_HOME ?? path.posix.join(home, '.local', 'share'), 'project-tendril');
}

export function defaultRuntimeDirectory(options: PlatformPaths = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'win32' && env.XDG_RUNTIME_DIR) return path.posix.join(env.XDG_RUNTIME_DIR, 'project-tendril');
  if (platform === 'win32' && env.LOCALAPPDATA) return path.win32.join(env.LOCALAPPDATA, 'Project Tendril', 'run');
  const temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
  const userIdentity = options.userIdentity ?? process.getuid?.() ?? os.userInfo().username;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  return platformPath.join(temporaryDirectory, `project-tendril-${userIdentity}`);
}

export const DEFAULT_CONFIG: TendrilConfig = {
  host: '127.0.0.1',
  port: 3210,
  browserBackend: 'obscura',
  headless: true,
  obscuraStealth: true,
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
  // SearXNG is preferred when configured and is skipped without an endpoint.
  searchProviders: ['searxng', 'duckduckgo', 'bing', 'google'],
  dataDir: defaultDataDirectory(),
  runtimeDir: defaultRuntimeDirectory(),
  logLevel: 'info',
};

const boundedString = (label: string, maximum = 4096) => z.string().trim().min(1, `${label} must not be empty`).max(maximum);
const secretString = (label: string, maximum = 4096) =>
  z
    .string()
    .min(1, `${label} must not be empty`)
    .max(maximum)
    .refine((value) => value === value.trim(), `${label} must not start or end with whitespace`);
const uniqueStringList = (label: string, maximum: number) =>
  z
    .array(boundedString(`${label} entry`))
    .max(maximum)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) context.addIssue({ code: 'custom', path: [index], message: `${label} entries must be unique` });
        seen.add(value);
      }
    });
const provider = z.enum(['duckduckgo', 'bing', 'google', 'searxng']);
const providers = z
  .array(provider)
  .min(1)
  .max(4)
  .superRefine((values, context) => {
    const seen = new Set<SearchProviderName>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) context.addIssue({ code: 'custom', path: [index], message: 'searchProviders entries must be unique' });
      seen.add(value);
    }
  });
const optionalUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'must use http or https')
  .refine((value) => !new URL(value).username && !new URL(value).password, 'must not embed credentials')
  .optional();
const ownedDirectory = (label: string) =>
  boundedString(label).refine((value) => {
    const resolved = path.resolve(value);
    return resolved !== path.parse(resolved).root;
  }, `${label} must not be a filesystem root`);

const configObject = z.strictObject({
  host: boundedString('host', 255).regex(/^[^\s/]+$/, 'host must not contain whitespace or a path'),
  port: z.number().int().min(0).max(65_535),
  browserBackend: z.enum(['obscura', 'chromium']),
  headless: z.boolean(),
  executablePath: boundedString('executablePath').optional(),
  obscuraExecutablePath: boundedString('obscuraExecutablePath').optional(),
  obscuraStealth: z.boolean(),
  maxSessions: z.number().int().min(1).max(64),
  sessionIdleMs: z
    .number()
    .int()
    .min(1_000)
    .max(7 * 24 * 60 * 60_000),
  actionTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(10 * 60_000),
  navigationTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(10 * 60_000),
  maxSnapshotChars: z.number().int().min(1_000).max(2_000_000),
  maxResponseBodyBytes: z
    .number()
    .int()
    .min(1_024)
    .max(100 * 1024 * 1024),
  blockPrivateNetworks: z.boolean(),
  allowedHosts: uniqueStringList('allowedHosts', 256),
  blockedHosts: uniqueStringList('blockedHosts', 256),
  workspaceRoots: uniqueStringList('workspaceRoots', 64),
  searchProviders: providers,
  searxngUrl: optionalUrl,
  googleSearchApiKey: secretString('googleSearchApiKey').optional(),
  googleSearchCx: secretString('googleSearchCx').optional(),
  dataDir: ownedDirectory('dataDir'),
  runtimeDir: ownedDirectory('runtimeDir'),
  token: secretString('token').optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
});

const configSchema = configObject.superRefine((value, context) => {
  if (Boolean(value.googleSearchApiKey) !== Boolean(value.googleSearchCx)) {
    context.addIssue({ code: 'custom', path: ['googleSearchApiKey'], message: 'googleSearchApiKey and googleSearchCx must be configured together' });
  }
  if (path.resolve(value.dataDir) === path.resolve(value.runtimeDir)) {
    context.addIssue({ code: 'custom', path: ['runtimeDir'], message: 'runtimeDir must be different from persistent dataDir' });
  }
  if (value.browserBackend === 'obscura' && !value.headless) {
    context.addIssue({ code: 'custom', path: ['headless'], message: 'Obscura is headless-only; select browserBackend=chromium for headed mode' });
  }
});
const configPatchSchema = configObject.partial();

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`).join('; ');
}

function parsePatch(value: unknown, source: string): Partial<TendrilConfig> {
  const parsed = configPatchSchema.safeParse(value);
  if (!parsed.success) throw new TendrilError('CONFIGURATION_ERROR', `Invalid ${source}: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

function parseConfig(value: unknown): TendrilConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new TendrilError('CONFIGURATION_ERROR', `Invalid configuration: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

function envBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new TendrilError('CONFIGURATION_ERROR', `${name} must be a boolean`);
}

function envNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TendrilError('CONFIGURATION_ERROR', `${name} must be a finite number`);
  return parsed;
}

function envList(value: string | undefined): string[] | undefined {
  return value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function loadConfig(options: { configPath?: string; overrides?: Partial<TendrilConfig> } = {}): Promise<TendrilConfig> {
  const defaultPath = path.join(process.cwd(), 'tendril.config.json');
  const explicitPath = options.configPath ?? process.env.TENDRIL_CONFIG;
  const configPath = explicitPath ?? defaultPath;
  let fileConfig: Partial<TendrilConfig> = {};
  let rawConfig: string | undefined;
  try {
    rawConfig = await readFile(configPath, 'utf8');
  } catch (error) {
    if (explicitPath || !isMissingFile(error)) {
      throw new TendrilError('CONFIGURATION_ERROR', `Unable to read configuration at ${configPath}`, { cause: error });
    }
  }
  if (rawConfig !== undefined) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawConfig) as unknown;
    } catch (error) {
      throw new TendrilError('CONFIGURATION_ERROR', `Configuration at ${configPath} is not valid JSON`, { cause: error });
    }
    fileConfig = parsePatch(decoded, `configuration file ${configPath}`);
  }

  const envConfig: Partial<TendrilConfig> = {};
  const set = <K extends keyof TendrilConfig>(key: K, value: TendrilConfig[K] | undefined): void => {
    if (value !== undefined) envConfig[key] = value;
  };
  set('host', process.env.TENDRIL_HOST);
  set('port', envNumber(process.env.TENDRIL_PORT, 'TENDRIL_PORT'));
  set('browserBackend', process.env.TENDRIL_BROWSER_BACKEND as BrowserBackend | undefined);
  set('headless', envBoolean(process.env.TENDRIL_HEADLESS, 'TENDRIL_HEADLESS'));
  set('executablePath', process.env.TENDRIL_EXECUTABLE_PATH);
  set('obscuraExecutablePath', process.env.TENDRIL_OBSCURA_PATH);
  set('obscuraStealth', envBoolean(process.env.TENDRIL_OBSCURA_STEALTH, 'TENDRIL_OBSCURA_STEALTH'));
  set('maxSessions', envNumber(process.env.TENDRIL_MAX_SESSIONS, 'TENDRIL_MAX_SESSIONS'));
  set('sessionIdleMs', envNumber(process.env.TENDRIL_SESSION_IDLE_MS, 'TENDRIL_SESSION_IDLE_MS'));
  set('actionTimeoutMs', envNumber(process.env.TENDRIL_ACTION_TIMEOUT_MS, 'TENDRIL_ACTION_TIMEOUT_MS'));
  set('navigationTimeoutMs', envNumber(process.env.TENDRIL_NAVIGATION_TIMEOUT_MS, 'TENDRIL_NAVIGATION_TIMEOUT_MS'));
  set('maxSnapshotChars', envNumber(process.env.TENDRIL_MAX_SNAPSHOT_CHARS, 'TENDRIL_MAX_SNAPSHOT_CHARS'));
  set('maxResponseBodyBytes', envNumber(process.env.TENDRIL_MAX_RESPONSE_BODY_BYTES, 'TENDRIL_MAX_RESPONSE_BODY_BYTES'));
  set('blockPrivateNetworks', envBoolean(process.env.TENDRIL_BLOCK_PRIVATE_NETWORKS, 'TENDRIL_BLOCK_PRIVATE_NETWORKS'));
  set('allowedHosts', envList(process.env.TENDRIL_ALLOWED_HOSTS));
  set('blockedHosts', envList(process.env.TENDRIL_BLOCKED_HOSTS));
  set('workspaceRoots', envList(process.env.TENDRIL_WORKSPACE_ROOTS));
  set('searchProviders', envList(process.env.TENDRIL_SEARCH_PROVIDERS) as SearchProviderName[] | undefined);
  set('searxngUrl', process.env.TENDRIL_SEARXNG_URL ?? process.env.SEARXNG_URL);
  set('googleSearchApiKey', process.env.GOOGLE_SEARCH_API_KEY);
  set('googleSearchCx', process.env.GOOGLE_SEARCH_CX);
  set('dataDir', process.env.TENDRIL_DATA_DIR);
  set('runtimeDir', process.env.TENDRIL_RUNTIME_DIR);
  set('token', process.env.TENDRIL_TOKEN);
  set('logLevel', process.env.TENDRIL_LOG_LEVEL as TendrilConfig['logLevel'] | undefined);

  const overrideConfig = options.overrides === undefined ? {} : parsePatch(options.overrides, 'configuration overrides');
  const config = { ...DEFAULT_CONFIG, ...fileConfig, ...envConfig, ...overrideConfig };
  config.obscuraExecutablePath ??= path.join(config.dataDir, 'bin', process.platform === 'win32' ? 'obscura.exe' : 'obscura');
  return parseConfig(config);
}
