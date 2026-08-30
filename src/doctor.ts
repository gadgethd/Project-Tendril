import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findChromium } from './browser/chromium.js';
import { createRuntime } from './runtime.js';
import type { SearchProviderName, TendrilConfig } from './types.js';
import { ensureDir } from './util.js';

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  check: string;
  ok: boolean;
  detail: string;
}

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const [firstLine = 'Unknown error'] = message.split(/\r?\n/, 1);
  return firstLine.slice(0, 600);
}

function availableProviders(config: TendrilConfig): SearchProviderName[] {
  return config.searchProviders.filter((provider) => {
    if (provider === 'searxng') return Boolean(config.searxngUrl);
    if (provider === 'google') return Boolean(config.googleSearchApiKey && config.googleSearchCx);
    return true;
  });
}

export async function runDoctor(config: TendrilConfig, environment: NodeJS.ProcessEnv = process.env): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ check: 'Node.js', ok: nodeMajor >= 22, detail: process.version });

  let executable: string | undefined;
  try {
    executable = await findChromium(config.executablePath);
    const { stdout, stderr } = await execFileAsync(executable, ['--version'], { timeout: 10_000 });
    checks.push({ check: 'Chromium binary', ok: true, detail: `${executable} (${(stdout || stderr).trim()})` });
  } catch (error) {
    checks.push({ check: 'Chromium binary', ok: false, detail: errorDetail(error) });
  }

  try {
    await ensureDir(config.dataDir);
    await ensureDir(config.runtimeDir);
    checks.push({ check: 'Directories', ok: true, detail: `${config.dataDir}, ${config.runtimeDir}` });
  } catch (error) {
    checks.push({ check: 'Directories', ok: false, detail: errorDetail(error) });
  }

  const providers = availableProviders(config);
  const unavailable = config.searchProviders.filter((provider) => !providers.includes(provider));
  checks.push({
    check: 'Search providers',
    ok: providers.length > 0,
    detail: `ready: ${providers.join(', ') || 'none'}${unavailable.length > 0 ? `; not configured: ${unavailable.join(', ')}` : ''}`,
  });

  const noSandboxOverride = environment.TENDRIL_ALLOW_NO_SANDBOX === 'true';
  const runningAsRoot = process.getuid?.() === 0;
  if (noSandboxOverride) {
    checks.push({
      check: 'Chromium sandbox launch',
      ok: false,
      detail: 'TENDRIL_ALLOW_NO_SANDBOX=true disables the browser sandbox and is not production-ready',
    });
  } else if (runningAsRoot) {
    checks.push({
      check: 'Chromium sandbox launch',
      ok: false,
      detail: 'Running as root is refused; use the non-root container user or an unprivileged account',
    });
  } else if (!executable) {
    checks.push({ check: 'Chromium sandbox launch', ok: false, detail: 'Chromium binary check failed' });
  } else {
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      runtime = await createRuntime({ ...config, executablePath: executable, headless: true, maxSessions: 1 });
      const session = await runtime.manager.create({ headless: true });
      try {
        await session.setContent('<title>Tendril doctor</title><main>Sandbox launch probe</main>');
        const health = await session.health();
        if (!health.alive) throw new Error('Chromium process exited during the launch probe');
      } finally {
        await runtime.manager.close(session.id);
      }
      checks.push({ check: 'Chromium sandbox launch', ok: true, detail: 'Sandboxed create, render, health, and close probe passed' });
    } catch (error) {
      checks.push({ check: 'Chromium sandbox launch', ok: false, detail: errorDetail(error) });
    } finally {
      if (runtime) {
        try {
          await runtime.close();
        } catch (error) {
          checks.push({ check: 'Runtime cleanup', ok: false, detail: errorDetail(error) });
        }
      }
    }
  }

  return checks;
}
