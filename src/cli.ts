#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Command } from 'commander';
import { installObscura, OBSCURA_VERSION } from './browser/install-obscura.js';
import { acquireProfileFileLock } from './browser/profile-lock.js';
import { validateProfileName } from './browser/profile-name.js';
import { loadConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { createRuntime } from './runtime.js';
import { advertisedHost, formatUrlAuthority, startHttpServer } from './server/http.js';
import { runStdioMcp } from './server/mcp.js';
import { pathWithinOwnedRoot } from './util.js';
import { VERSION } from './version.js';

const program = new Command();

program
  .name('tendril')
  .description('Local agent-first browser runtime with Obscura and Chromium backends, MCP, REST, and CDP')
  .version(VERSION)
  .option('-c, --config <path>', 'configuration JSON path');

program
  .command('serve')
  .description('Start the HTTP MCP, REST, CDP, and dashboard service')
  .option('-p, --port <port>', 'listen port', Number)
  .option('--host <host>', 'listen host')
  .option('--headed', 'show Chromium windows')
  .option('--allow-private-network', 'allow browser access to localhost and private networks')
  .action(async (options) => {
    const root = program.opts<{ config?: string }>();
    const config = await loadConfig({
      configPath: root.config,
      overrides: {
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.host ? { host: options.host } : {}),
        ...(options.headed ? { browserBackend: 'chromium' as const, headless: false } : {}),
        ...(options.allowPrivateNetwork ? { blockPrivateNetworks: false } : {}),
      },
    });
    const runtime = await createRuntime(config);
    const httpServer = await startHttpServer({ ...runtime });
    process.stdout.write(
      `Project Tendril ${VERSION}\nDashboard: ${httpServer.dashboardUrl}\nMCP: http://${formatUrlAuthority(advertisedHost(config.host), httpServer.port)}/mcp\n`,
    );
    await waitForShutdown(async () => {
      await httpServer.close();
      await runtime.close();
    });
  });

program
  .command('mcp')
  .description('Run Tendril as a local stdio MCP server')
  .option('--headed', 'show Chromium windows')
  .option('--allow-private-network', 'allow browser access to localhost and private networks')
  .action(async (options) => {
    const root = program.opts<{ config?: string }>();
    const config = await loadConfig({
      configPath: root.config,
      overrides: {
        ...(options.headed ? { browserBackend: 'chromium' as const, headless: false } : {}),
        ...(options.allowPrivateNetwork ? { blockPrivateNetworks: false } : {}),
      },
    });
    const runtime = await createRuntime(config);
    await runStdioMcp(runtime);
    await waitForShutdown(() => runtime.close(), true);
  });

program
  .command('doctor')
  .description('Check runtime, configured browser backend, directories, and prerequisites')
  .action(async () => {
    const root = program.opts<{ config?: string }>();
    const config = await loadConfig({ configPath: root.config });
    const checks = await runDoctor(config);
    for (const check of checks) process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.check}: ${check.detail}\n`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });

program
  .command('install-browser')
  .description('Install the configured browser backend')
  .action(async () => {
    const config = await loadConfig({ configPath: program.opts<{ config?: string }>().config });
    if (config.browserBackend === 'obscura') {
      const installed = await installObscura(config.obscuraExecutablePath!);
      process.stdout.write(`Installed Obscura ${OBSCURA_VERSION} at ${installed}\n`);
      return;
    }
    const require = createRequire(import.meta.url);
    const cli = require.resolve('playwright/cli');
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    const code = await new Promise<number>((resolve) => child.once('exit', (value) => resolve(value ?? 1)));
    if (code !== 0) process.exitCode = code;
  });

const profiles = program.command('profiles').description('Manage named persistent browser profiles');
profiles.command('list').action(async () => {
  const config = await loadConfig({ configPath: program.opts<{ config?: string }>().config });
  const directory = path.join(config.dataDir, 'profiles');
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory())) process.stdout.write(`${entry.name}\n`);
  } catch {
    /* No profiles yet. */
  }
});
profiles
  .command('delete <name>')
  .description('Permanently delete a named profile')
  .action(async (name: string) => {
    const profile = validateProfileName(name);
    const config = await loadConfig({ configPath: program.opts<{ config?: string }>().config });
    const target = pathWithinOwnedRoot(pathWithinOwnedRoot(config.dataDir, 'profiles'), profile);
    const lock = await acquireProfileFileLock(config.dataDir, profile);
    try {
      // profile is a portable basename and target is contained beneath the operator-owned profiles root.
      // lgtm[js/path-injection]
      await rm(target, { recursive: true, force: true });
    } finally {
      await lock.release();
    }
    process.stdout.write(`Deleted profile ${profile}. This cannot be recovered.\n`);
  });

async function waitForShutdown(close: () => Promise<void>, stdin = false): Promise<void> {
  let resolved = false;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    if (stdin) process.stdin.once('end', finish);
  });
  await close();
}

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`tendril: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
