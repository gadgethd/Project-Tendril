#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { findChromium } from './browser/chromium.js';
import { createRuntime } from './runtime.js';
import { runStdioMcp } from './server/mcp.js';
import { startHttpServer } from './server/http.js';
import { ensureDir } from './util.js';
import { VERSION } from './version.js';

const execFileAsync = promisify(execFile);
const program = new Command();

program
  .name('tendril')
  .description('Local agent-first Chromium browser with MCP, REST, and CDP')
  .version(VERSION)
  .option('-c, --config <path>', 'configuration JSON path');

program.command('serve')
  .description('Start the HTTP MCP, REST, CDP, and dashboard service')
  .option('-p, --port <port>', 'listen port', Number)
  .option('--host <host>', 'listen host')
  .option('--headed', 'show Chromium windows')
  .option('--allow-private-network', 'allow browser access to localhost and private networks')
  .action(async (options) => {
    const root = program.opts<{ config?: string }>();
    const config = await loadConfig({ configPath: root.config, overrides: {
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.headed ? { headless: false } : {}),
      ...(options.allowPrivateNetwork ? { blockPrivateNetworks: false } : {}),
    } });
    const runtime = await createRuntime(config);
    const httpServer = await startHttpServer({ ...runtime });
    process.stdout.write(`Project Tendril ${VERSION}\nDashboard: ${httpServer.dashboardUrl}\nMCP: http://${config.host}:${httpServer.port}/mcp\n`);
    await waitForShutdown(async () => { await httpServer.close(); await runtime.close(); });
  });

program.command('mcp')
  .description('Run Tendril as a local stdio MCP server')
  .option('--headed', 'show Chromium windows')
  .option('--allow-private-network', 'allow browser access to localhost and private networks')
  .action(async (options) => {
    const root = program.opts<{ config?: string }>();
    const config = await loadConfig({ configPath: root.config, overrides: {
      ...(options.headed ? { headless: false } : {}),
      ...(options.allowPrivateNetwork ? { blockPrivateNetworks: false } : {}),
    } });
    const runtime = await createRuntime(config);
    await runStdioMcp(runtime);
    await waitForShutdown(() => runtime.close(), true);
  });

program.command('doctor')
  .description('Check runtime, Chromium, directories, and sandbox prerequisites')
  .action(async () => {
    const root = program.opts<{ config?: string }>();
    const config = await loadConfig({ configPath: root.config });
    const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
    checks.push({ check: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version });
    try {
      const executable = await findChromium(config.executablePath);
      const { stdout, stderr } = await execFileAsync(executable, ['--version'], { timeout: 10_000 });
      checks.push({ check: 'Chromium', ok: true, detail: `${executable} (${(stdout || stderr).trim()})` });
    } catch (error) {
      checks.push({ check: 'Chromium', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    try { await ensureDir(config.dataDir); await ensureDir(config.runtimeDir); checks.push({ check: 'Directories', ok: true, detail: `${config.dataDir}, ${config.runtimeDir}` }); }
    catch (error) { checks.push({ check: 'Directories', ok: false, detail: String(error) }); }
    checks.push({ check: 'Non-root sandbox', ok: process.getuid?.() !== 0, detail: process.getuid?.() === 0 ? 'Running as root is refused by default' : 'Process is non-root' });
    for (const check of checks) process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.check}: ${check.detail}\n`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });

program.command('install-browser')
  .description('Install Playwright-managed Chromium')
  .action(async () => {
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
  } catch { /* No profiles yet. */ }
});
profiles.command('delete <name>').description('Permanently delete a named profile').action(async (name: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('Invalid profile name');
  const config = await loadConfig({ configPath: program.opts<{ config?: string }>().config });
  const target = path.join(config.dataDir, 'profiles', name);
  await rm(target, { recursive: true, force: true });
  process.stdout.write(`Deleted profile ${name}. This cannot be recovered.\n`);
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
