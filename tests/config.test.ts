import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDataDirectory, defaultRuntimeDirectory, loadConfig } from '../src/config.js';

const temporaryDirectories: string[] = [];
const originalWorkingDirectory = process.cwd();

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tendril-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  process.chdir(originalWorkingDirectory);
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('configuration', () => {
  it('uses platform-native data and runtime locations', () => {
    expect(defaultDataDirectory({ platform: 'linux', env: { XDG_DATA_HOME: '/xdg' }, home: '/home/test' })).toBe('/xdg/project-tendril');
    expect(defaultDataDirectory({ platform: 'darwin', env: {}, home: '/Users/test' })).toBe('/Users/test/Library/Application Support/Project Tendril');
    expect(defaultDataDirectory({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Local' }, home: 'C:\\Users\\test' })).toBe('C:\\Local\\Project Tendril');
    expect(defaultRuntimeDirectory({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1' } })).toBe('/run/user/1/project-tendril');
    expect(defaultRuntimeDirectory({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Local' } })).toBe('C:\\Local\\Project Tendril\\run');
  });

  it('uses defaults only when the implicit config file is absent', async () => {
    const directory = await temporaryDirectory();
    process.chdir(directory);
    await expect(loadConfig()).resolves.toMatchObject({ host: '127.0.0.1', port: 3210 });
    await writeFile(path.join(directory, 'tendril.config.json'), '{ invalid');
    await expect(loadConfig()).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('not valid JSON') });
  });

  it('applies defaults, file, environment, and overrides in order', async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ port: 3100, maxSnapshotChars: 10_000, logLevel: 'warn' }));
    vi.stubEnv('TENDRIL_PORT', '3200');
    vi.stubEnv('TENDRIL_MAX_SNAPSHOT_CHARS', '12000');
    const config = await loadConfig({ configPath, overrides: { port: 3300 } });
    expect(config).toMatchObject({ port: 3300, maxSnapshotChars: 12_000, logLevel: 'warn' });
  });

  it('accepts the checked-in example without disabling workspace access', async () => {
    const config = await loadConfig({ configPath: path.resolve('tendril.config.example.json') });
    expect(config.workspaceRoots).toEqual(['.']);
    expect(config.searchProviders[0]).toBe('searxng');
    expect(config.allowedHosts).toContain('localhost');
  });

  it.each([
    [{ unknownOption: true }, 'Unrecognized key'],
    [{ headless: 'yes' }, 'headless'],
    [{ maxSessions: 1.5 }, 'maxSessions'],
    [{ sessionIdleMs: 0 }, 'sessionIdleMs'],
    [{ actionTimeoutMs: -1 }, 'actionTimeoutMs'],
    [{ searchProviders: ['unknown'] }, 'searchProviders'],
    [{ searchProviders: ['bing', 'bing'] }, 'unique'],
    [{ logLevel: 'verbose' }, 'logLevel'],
    [{ searxngUrl: 'file:///tmp/search' }, 'http or https'],
    [{ searxngUrl: 'https://user:password@example.test' }, 'must not embed credentials'],
    [{ googleSearchApiKey: 'key-without-cx' }, 'configured together'],
    [{ dataDir: '/tmp/shared', runtimeDir: '/tmp/shared' }, 'must be different'],
    [{ dataDir: path.parse(process.cwd()).root }, 'must not be a filesystem root'],
  ])('rejects invalid file configuration %#', async (value, message) => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(value));
    await expect(loadConfig({ configPath })).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining(message) });
  });

  it('rejects invalid environment values and override objects', async () => {
    vi.stubEnv('TENDRIL_PORT', '3.14');
    await expect(loadConfig()).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('port') });
    vi.stubEnv('TENDRIL_PORT', '3210');
    const unsafeOverride = { unexpected: true } as Partial<Parameters<typeof loadConfig>[0]>;
    await expect(loadConfig({ overrides: unsafeOverride as never })).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('Unrecognized key') });
  });

  it('fails closed for an explicitly selected missing file', async () => {
    const directory = await temporaryDirectory();
    await expect(loadConfig({ configPath: path.join(directory, 'missing.json') })).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });
});
