import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { TendrilError } from '../errors.js';
import { ensureDir, pathWithinOwnedRoot, withTimeout, type Logger } from '../util.js';

export interface ChromiumProcess {
  browser: Browser;
  context: BrowserContext;
  child: ChildProcess;
  cdpPort: number;
  browserPath: string;
  userDataDir: string;
  close(): Promise<void>;
}

async function firstAccessible(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching.
    }
  }
  return undefined;
}

export async function findChromium(explicit?: string): Promise<string> {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  try { candidates.push(chromium.executablePath()); } catch { /* browser not installed */ }
  if (process.platform === 'linux') {
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome');
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  }
  const found = await firstAccessible([...new Set(candidates)]);
  if (!found) {
    throw new TendrilError(
      'BROWSER_LAUNCH_FAILED',
      'No Chromium executable found. Run `tendril install-browser` or set TENDRIL_EXECUTABLE_PATH.',
    );
  }
  return found;
}

async function waitForDevTools(userDataDir: string, child: ChildProcess, timeoutMs = 15_000): Promise<{ port: number; browserPath: string }> {
  const activePortPath = pathWithinOwnedRoot(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Chromium exited with code ${child.exitCode}`);
    try {
      // activePortPath is a fixed basename beneath the manager-owned session/profile directory.
      // lgtm[js/path-injection]
      const [portLine, browserPath] = (await readFile(activePortPath, 'utf8')).trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && browserPath) return { port, browserPath };
    } catch {
      // Chromium has not written the endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chromium did not create ${activePortPath}`);
}

export interface ProcessTerminationOptions {
  platform?: NodeJS.Platform;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
  signalPosixGroup?: (pid: number, signal: NodeJS.Signals) => void;
  posixGroupAlive?: (pid: number) => boolean;
  posixExitCleanup?: (cleanupDeadline?: number) => Promise<void>;
  taskkill?: (pid: number) => Promise<void>;
  windowsProcessList?: () => Promise<WindowsProcessRecord[]>;
  windowsRootIdentity?: WindowsProcessRecord;
  windowsExitCleanup?: WindowsExitCleanup;
  cleanupDeadline?: number;
}

export interface WindowsProcessRecord {
  pid: number;
  parentPid: number;
  creationDate: string;
}

interface WindowsProcessTreeSnapshot {
  root: WindowsProcessRecord;
  descendants: WindowsProcessRecord[];
}

export interface WindowsExitCleanup {
  (cleanupDeadline?: number): Promise<void>;
  markVerified(): void;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function validatedPid(child: ChildProcess): number | undefined {
  return Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0 ? child.pid : undefined;
}

function boundedCleanupTimeout(options: ProcessTerminationOptions, fallbackMs: number, stage: string): number {
  if (options.cleanupDeadline === undefined) return fallbackMs;
  const remaining = options.cleanupDeadline - Date.now();
  if (remaining <= 0) throw new Error(`Chromium ${stage} exceeded the global cleanup deadline`);
  return Math.max(1, Math.min(fallbackMs, remaining));
}

function defaultPosixGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') {
        // macOS can reject a stale/reused process-group id with EPERM (the
        // group is not ours or its leader is gone). Probe the leader directly:
        // an unreachable group cannot keep our work alive, so treat it as dead
        // rather than failing session cleanup.
        try {
          process.kill(pid, 0);
          return true;
        } catch (leaderError) {
          return false;
        }
      }
    }
    throw error;
  }
}

function defaultSignalPosixGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error)) throw error;
    if (error.code === 'ESRCH') return;
    if (error.code === 'EPERM') {
      // Group signalling is not permitted (macOS stale group / foreign group).
      // Fall back to the leader so best-effort cleanup still runs; if the
      // leader is also unreachable the group is functionally gone.
      try {
        process.kill(pid, signal);
      } catch {
        // Ignore: the process group is already unreachable.
      }
      return;
    }
    throw error;
  }
}

export function trackPosixProcessGroup(
  child: ChildProcess,
  options: Pick<ProcessTerminationOptions, 'gracefulTimeoutMs' | 'forceTimeoutMs' | 'posixGroupAlive' | 'signalPosixGroup'> = {},
): (cleanupDeadline?: number) => Promise<void> {
  const pid = validatedPid(child);
  if (pid === undefined) return async () => undefined;
  const groupAlive = options.posixGroupAlive ?? defaultPosixGroupAlive;
  const signalGroup = options.signalPosixGroup ?? defaultSignalPosixGroup;
  let cleanup: Promise<void> | undefined;
  let joinedDeadline = Number.POSITIVE_INFINITY;
  const begin = (cleanupDeadline?: number): Promise<void> => {
    if (cleanupDeadline !== undefined) joinedDeadline = Math.min(joinedDeadline, cleanupDeadline);
    if (!cleanup) {
      // This check runs synchronously in the child's exit event. A surviving member
      // pins the old PGID; an empty group settles immediately and is never probed or
      // signalled later after that numeric ID could be reused.
      let groupWasPinnedAtExit: boolean;
      try {
        groupWasPinnedAtExit = groupAlive(pid);
      } catch (error) {
        cleanup = Promise.reject(error);
        void cleanup.catch(() => undefined);
        return cleanup;
      }
      cleanup = (async () => {
        if (!groupWasPinnedAtExit) return;
        if (await waitForTermination(child, () => !groupAlive(pid), options.gracefulTimeoutMs ?? 3_000, () => joinedDeadline)) return;
        try {
          signalGroup(pid, 'SIGTERM');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
        if (await waitForTermination(child, () => !groupAlive(pid), options.gracefulTimeoutMs ?? 3_000, () => joinedDeadline)) return;
        try {
          signalGroup(pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
        if (!await waitForTermination(child, () => !groupAlive(pid), options.forceTimeoutMs ?? 3_000, () => joinedDeadline)) {
          throw new Error(`Chromium process group ${pid} did not exit after child-exit cleanup`);
        }
      })();
      void cleanup.catch(() => undefined);
    }
    return cleanup;
  };
  child.once('exit', () => { void begin(); });
  if (childHasExited(child)) void begin();
  return begin;
}

export function windowsTaskkillArguments(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Refusing to invoke taskkill with an invalid PID');
  return ['/PID', String(pid), '/T', '/F'];
}

export async function runBoundedHelper(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    maxOutputBytes?: number;
    acceptNonZero?: boolean;
    postKillJoinTimeoutMs?: number;
    spawnProcess?: typeof spawn;
  },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const helper = (options.spawnProcess ?? spawn)(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    let settled = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    const maximumOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const postKillJoinTimeoutMs = Math.max(10, Math.min(
      options.postKillJoinTimeoutMs ?? Math.max(25, Math.floor(options.timeoutMs / 4)),
      Math.max(10, options.timeoutMs - 1),
    ));
    const operationTimeoutMs = Math.max(1, options.timeoutMs - postKillJoinTimeoutMs);
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (error) reject(error);
      else resolve(value ?? '');
    };
    const terminate = (error: Error): void => {
      if (failure) return;
      failure = error;
      helper.kill('SIGKILL');
      terminationTimer = setTimeout(() => {
        helper.stdout?.destroy();
        helper.stderr?.destroy();
        helper.unref();
        finish(new AggregateError(
          [error],
          `${command} did not report exit after forced helper termination`,
        ));
      }, postKillJoinTimeoutMs);
    };
    helper.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > maximumOutputBytes) terminate(new Error(`${command} exceeded its output limit`));
    });
    helper.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < 16_384) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => terminate(new Error(`${command} timed out after ${options.timeoutMs}ms`)), operationTimeoutMs);
    helper.once('error', (error) => {
      finish(error);
    });
    helper.once('close', (code) => {
      if (failure) finish(failure);
      else if (code === 0 || options.acceptNonZero) finish(undefined, stdout);
      else finish(new Error(`${command} failed with code ${code}: ${stderr.slice(-4_000)}`));
    });
  });
}

async function defaultTaskkill(pid: number, timeoutMs: number): Promise<void> {
  // A non-zero result can mean the process exited between enumeration and taskkill;
  // the stable-identity survivor check below is authoritative.
  await runBoundedHelper('taskkill', windowsTaskkillArguments(pid), { timeoutMs, acceptNonZero: true });
}

async function taskkillWindowsPid(pid: number, options: ProcessTerminationOptions, timeoutMs: number): Promise<void> {
  if (options.taskkill) {
    await withTimeout(
      options.taskkill(pid),
      timeoutMs,
      `Windows Chromium process-tree termination for PID ${pid}`,
    );
  } else {
    await defaultTaskkill(pid, timeoutMs);
  }
}

export const WINDOWS_PROCESS_LIST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { [PSCustomObject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; CreationDate = $_.CreationDate.ToUniversalTime().ToString('o') } })",
].join('; ');

async function defaultWindowsProcessList(timeoutMs: number): Promise<WindowsProcessRecord[]> {
  const output = await runBoundedHelper(
    'powershell.exe',
    [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_LIST_SCRIPT,
    ],
    { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output) as unknown;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  if (records.length > 65_536) throw new Error('Windows process enumeration returned too many records');
  return records.map((record) => {
    if (!record || typeof record !== 'object') throw new Error('Windows process enumeration returned an invalid record');
    const value = record as Record<string, unknown>;
    const pid = Number(value.ProcessId);
    const parentPid = Number(value.ParentProcessId);
    const creationDate = String(value.CreationDate ?? '');
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0 || !creationDate) {
      throw new Error('Windows process enumeration returned an invalid process identity');
    }
    return { pid, parentPid, creationDate };
  });
}

function windowsProcessKey(record: WindowsProcessRecord): string {
  return `${record.pid}:${record.creationDate}`;
}

function windowsCreationTime(record: WindowsProcessRecord): number {
  const value = Date.parse(record.creationDate);
  if (!Number.isFinite(value)) {
    throw new Error(`Windows process enumeration returned an invalid creation date for PID ${record.pid}`);
  }
  return value;
}

export function captureWindowsProcessTree(
  rootPid: number,
  processes: WindowsProcessRecord[],
  expectedRoot?: WindowsProcessRecord,
): WindowsProcessTreeSnapshot {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('Cannot capture a Windows process tree for an invalid PID');
  if (processes.length > 65_536) throw new Error('Windows process enumeration returned too many records');
  const byPid = new Map<number, WindowsProcessRecord>();
  const creationTimes = new Map<number, number>();
  const childrenByParent = new Map<number, WindowsProcessRecord[]>();
  for (const record of processes) {
    if (
      !Number.isSafeInteger(record.pid) || record.pid <= 0
      || !Number.isSafeInteger(record.parentPid) || record.parentPid < 0
      || !record.creationDate
    ) {
      throw new Error('Windows process enumeration returned an invalid process identity');
    }
    if (byPid.has(record.pid)) throw new Error(`Windows process enumeration returned duplicate PID ${record.pid}`);
    byPid.set(record.pid, record);
    creationTimes.set(record.pid, windowsCreationTime(record));
    const siblings = childrenByParent.get(record.parentPid) ?? [];
    siblings.push(record);
    childrenByParent.set(record.parentPid, siblings);
  }
  const root = byPid.get(rootPid);
  if (!root) throw new Error(`Unable to establish Windows Chromium process identity for PID ${rootPid}`);
  if (expectedRoot && windowsProcessKey(root) !== windowsProcessKey(expectedRoot)) {
    throw new Error(`Windows Chromium PID ${rootPid} no longer has its launch-time process identity`);
  }
  const descendants: WindowsProcessRecord[] = [];
  const discovered = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index += 1) {
    const parentPid = queue[index]!;
    const parentCreationTime = creationTimes.get(parentPid)!;
    for (const record of childrenByParent.get(parentPid) ?? []) {
      if (discovered.has(record.pid)) continue;
      if (creationTimes.get(record.pid)! < parentCreationTime) {
        throw new Error(`Windows process ${record.pid} predates its reported parent ${parentPid}`);
      }
      discovered.add(record.pid);
      descendants.push(record);
      queue.push(record.pid);
    }
  }
  return { root, descendants };
}

function windowsTreeSurvivors(
  snapshot: WindowsProcessTreeSnapshot,
  processes: WindowsProcessRecord[],
): WindowsProcessRecord[] {
  const current = new Set(processes.map(windowsProcessKey));
  return [snapshot.root, ...snapshot.descendants].filter((record) => current.has(windowsProcessKey(record)));
}

export function captureExitedWindowsProcessTree(
  launchSnapshot: WindowsProcessTreeSnapshot,
  processes: WindowsProcessRecord[],
  exitedAt: number,
): WindowsProcessTreeSnapshot {
  if (!Number.isFinite(exitedAt)) throw new Error('Windows Chromium exit time is invalid');
  const byPid = new Map<number, WindowsProcessRecord>();
  const childrenByParent = new Map<number, WindowsProcessRecord[]>();
  for (const record of processes) {
    if (byPid.has(record.pid)) throw new Error(`Windows process enumeration returned duplicate PID ${record.pid}`);
    windowsCreationTime(record);
    byPid.set(record.pid, record);
    const children = childrenByParent.get(record.parentPid) ?? [];
    children.push(record);
    childrenByParent.set(record.parentPid, children);
  }

  const descendants = new Map<string, WindowsProcessRecord>();
  for (const record of launchSnapshot.descendants) descendants.set(windowsProcessKey(record), record);
  const currentRoot = byPid.get(launchSnapshot.root.pid);
  const rootIdentityMatches = currentRoot !== undefined
    && windowsProcessKey(currentRoot) === windowsProcessKey(launchSnapshot.root);
  // Once the launch root is absent or its numeric PID belongs to another
  // process, current children of that PID cannot be attributed to Chromium.
  const queue: WindowsProcessRecord[] = rootIdentityMatches ? [launchSnapshot.root] : [];
  for (const record of launchSnapshot.descendants) {
    const current = byPid.get(record.pid);
    if (current && windowsProcessKey(current) === windowsProcessKey(record)) queue.push(record);
  }
  const inspectedParents = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    const parentKey = windowsProcessKey(parent);
    if (inspectedParents.has(parentKey)) continue;
    inspectedParents.add(parentKey);
    const parentCreationTime = windowsCreationTime(parent);
    for (const child of childrenByParent.get(parent.pid) ?? []) {
      if (child.pid === launchSnapshot.root.pid && windowsProcessKey(child) !== windowsProcessKey(launchSnapshot.root)) continue;
      const childCreationTime = windowsCreationTime(child);
      if (childCreationTime > exitedAt) continue;
      if (childCreationTime < parentCreationTime) {
        throw new Error(`Windows process ${child.pid} predates its reported parent ${parent.pid}`);
      }
      const childKey = windowsProcessKey(child);
      if (!descendants.has(childKey)) descendants.set(childKey, child);
      queue.push(child);
    }
  }
  descendants.delete(windowsProcessKey(launchSnapshot.root));
  return { root: launchSnapshot.root, descendants: [...descendants.values()] };
}

export function trackWindowsProcessTree(
  child: ChildProcess,
  launchSnapshotPromise: Promise<WindowsProcessTreeSnapshot>,
  options: Pick<ProcessTerminationOptions, 'gracefulTimeoutMs' | 'forceTimeoutMs' | 'taskkill' | 'windowsProcessList'> = {},
): WindowsExitCleanup {
  let cleanup: Promise<void> | undefined;
  let joinedDeadline = Number.POSITIVE_INFINITY;
  let exitedAt: number | undefined;
  let externallyVerified = false;
  const begin = (cleanupDeadline?: number): Promise<void> => {
    if (cleanupDeadline !== undefined) joinedDeadline = Math.min(joinedDeadline, cleanupDeadline);
    exitedAt ??= Date.now();
    if (!cleanup) {
      cleanup = (async () => {
        const scoped = (): ProcessTerminationOptions => ({
          ...options,
          ...(Number.isFinite(joinedDeadline) ? { cleanupDeadline: joinedDeadline } : {}),
        });
        const launchSnapshot = await withTimeout(
          launchSnapshotPromise,
          boundedCleanupTimeout(scoped(), options.forceTimeoutMs ?? 3_000, 'Windows launch identity join'),
          'Windows Chromium launch identity capture',
        );
        const immediateProcesses = await listWindowsProcesses(
          scoped(),
          boundedCleanupTimeout(scoped(), options.forceTimeoutMs ?? 3_000, 'Windows child-exit enumeration'),
        );
        const exitSnapshot = captureExitedWindowsProcessTree(launchSnapshot, immediateProcesses, exitedAt!);
        if (externallyVerified) return;
        if (windowsTreeSurvivors(exitSnapshot, immediateProcesses).length === 0) return;

        const naturalExitDeadline = Date.now() + (options.gracefulTimeoutMs ?? 3_000);
        while (!externallyVerified && Date.now() < Math.min(naturalExitDeadline, joinedDeadline)) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (externallyVerified) return;
        const beforeForce = await listWindowsProcesses(
          scoped(),
          boundedCleanupTimeout(scoped(), options.forceTimeoutMs ?? 3_000, 'Windows child-exit survivor enumeration'),
        );
        if (windowsTreeSurvivors(exitSnapshot, beforeForce).length === 0) return;
        await forceWindowsProcessTree(child, exitSnapshot, scoped());
      })();
      void cleanup.catch(() => undefined);
    }
    return cleanup;
  };
  const join = begin as WindowsExitCleanup;
  join.markVerified = () => { externallyVerified = true; };
  child.once('exit', () => { void begin(); });
  if (childHasExited(child)) void begin();
  return join;
}

async function listWindowsProcesses(options: ProcessTerminationOptions, timeoutMs: number): Promise<WindowsProcessRecord[]> {
  if (options.windowsProcessList) {
    return withTimeout(options.windowsProcessList(), timeoutMs, 'Windows Chromium process-tree enumeration');
  }
  return defaultWindowsProcessList(timeoutMs);
}

export async function captureWindowsLaunchProcessTree(
  child: ChildProcess,
  windowsProcessList: () => Promise<WindowsProcessRecord[]>,
): Promise<WindowsProcessTreeSnapshot> {
  const pid = validatedPid(child);
  if (pid === undefined) throw new Error('Windows Chromium did not expose a valid launch PID');
  if (childHasExited(child)) throw new Error('Windows Chromium exited before launch identity capture');
  const processes = await windowsProcessList();
  // The enumeration is a point-in-time identity snapshot. The main process may
  // exit before this continuation runs, but its captured descendants remain ours.
  return captureWindowsProcessTree(pid, processes);
}

async function forceWindowsProcessTree(
  child: ChildProcess,
  snapshot: WindowsProcessTreeSnapshot,
  options: ProcessTerminationOptions,
): Promise<void> {
  const forceTimeoutMs = options.forceTimeoutMs ?? 3_000;
  const deadline = Math.min(
    Date.now() + forceTimeoutMs,
    options.cleanupDeadline ?? Number.POSITIVE_INFINITY,
  );
  const remaining = (stage: string): number => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error(`Windows Chromium ${stage} exceeded the force-cleanup deadline`);
    return value;
  };
  const current = await listWindowsProcesses(options, remaining('process enumeration'));
  const survivors = windowsTreeSurvivors(snapshot, current);
  const survivorPids = new Set(survivors.map((record) => record.pid));
  const roots = survivors.filter((record) => !survivorPids.has(record.parentPid));
  let nextRoot = 0;
  const workers = Array.from({ length: Math.min(4, roots.length) }, async () => {
    while (nextRoot < roots.length) {
      const record = roots[nextRoot++]!;
      await taskkillWindowsPid(record.pid, options, remaining(`taskkill for PID ${record.pid}`));
    }
  });
  const workerResults = await Promise.allSettled(workers);
  const taskkillFailures = workerResults
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason as unknown);
  if (taskkillFailures.length) {
    throw new AggregateError(taskkillFailures, 'One or more Windows Chromium process-tree roots failed to terminate');
  }
  if (!childHasExited(child) && !await waitForTermination(child, () => childHasExited(child), remaining('main-process exit'))) {
    throw new Error(`Chromium main process ${snapshot.root.pid} did not report exit after taskkill`);
  }
  const remainingProcesses = windowsTreeSurvivors(
    snapshot,
    await listWindowsProcesses(options, remaining('survivor verification')),
  );
  if (remainingProcesses.length) {
    throw new Error(`Chromium process tree still has ${remainingProcesses.length} verified survivor(s) after taskkill`);
  }
}

async function requestChromiumShutdown(browser: Pick<Browser, 'close'> & Partial<Pick<Browser, 'newBrowserCDPSession'>>): Promise<void> {
  if (browser.newBrowserCDPSession) {
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close');
    } finally {
      // connectOverCDP Browser.close() disconnects the Playwright client; the CDP
      // Browser.close command above is what asks Chromium to flush and terminate.
      await browser.close().catch(() => undefined);
    }
    return;
  }
  // Deterministic test doubles and non-Chromium callers use the legacy fallback.
  await browser.close();
}

async function waitForTermination(
  child: ChildProcess,
  terminated: () => boolean,
  timeoutMs: number,
  joinedDeadline?: () => number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<boolean>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off('exit', check);
      resolve(value);
    };
    const check = (): void => {
      if (settled) return;
      try {
        if (terminated()) { finish(true); return; }
        if (Date.now() >= Math.min(deadline, joinedDeadline?.() ?? Number.POSITIVE_INFINITY)) { finish(false); return; }
        if (timer) clearTimeout(timer);
        timer = setTimeout(check, 25);
        // Process-tree verification is part of shutdown correctness, so this poller
        // intentionally remains referenced until finish() clears it.
      } catch (error) {
        settled = true;
        if (timer) clearTimeout(timer);
        child.off('exit', check);
        reject(error);
      }
    };
    child.on('exit', check);
    check();
  });
}

export async function terminateProcessTree(child: ChildProcess, options: ProcessTerminationOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const gracefulTimeoutMs = (): number => boundedCleanupTimeout(options, options.gracefulTimeoutMs ?? 3_000, 'graceful process-tree termination');
  const forceTimeoutMs = (): number => boundedCleanupTimeout(options, options.forceTimeoutMs ?? 3_000, 'forced process-tree termination');
  const pid = validatedPid(child);
  if (pid === undefined) {
    if (childHasExited(child)) return;
    child.kill('SIGKILL');
    if (!await waitForTermination(child, () => childHasExited(child), forceTimeoutMs(), () => options.cleanupDeadline ?? Number.POSITIVE_INFINITY)) {
      throw new Error('Chromium process exit could not be verified after SIGKILL');
    }
    return;
  }

  if (platform === 'win32') {
    if (childHasExited(child) && options.windowsExitCleanup) {
      await withTimeout(
        options.windowsExitCleanup(options.cleanupDeadline),
        forceTimeoutMs(),
        'Windows Chromium child-exit cleanup',
      );
      return;
    }
    if (!options.windowsRootIdentity) {
      if (childHasExited(child)) throw new Error('Windows Chromium launch-time process identity is unavailable after main-process exit');
      await taskkillWindowsPid(pid, options, forceTimeoutMs());
      if (!await waitForTermination(child, () => childHasExited(child), forceTimeoutMs(), () => options.cleanupDeadline ?? Number.POSITIVE_INFINITY)) {
        throw new Error(`Chromium main process ${pid} did not report exit after identity-safe immediate taskkill`);
      }
      throw new Error('Windows Chromium descendants were terminated but could not be identity-verified');
    }
    const snapshot = captureWindowsProcessTree(
      pid,
      await listWindowsProcesses(options, forceTimeoutMs()),
      options.windowsRootIdentity,
    );
    await forceWindowsProcessTree(child, snapshot, options);
    options.windowsExitCleanup?.markVerified();
    if (options.windowsExitCleanup) {
      await withTimeout(
        options.windowsExitCleanup(options.cleanupDeadline),
        forceTimeoutMs(),
        'Windows Chromium exit-tracker join',
      ).catch(() => undefined);
    }
    return;
  }

  const groupAlive = options.posixGroupAlive ?? defaultPosixGroupAlive;
  const signalGroup = options.signalPosixGroup ?? defaultSignalPosixGroup;
  if (childHasExited(child)) {
    if (options.posixExitCleanup) {
      await options.posixExitCleanup(options.cleanupDeadline);
      return;
    }
    throw new Error(`Chromium main process ${pid} already exited; refusing to signal an untracked, potentially reused process group`);
  }
  const terminated = (): boolean => childHasExited(child) && !groupAlive(pid);
  try {
    signalGroup(pid, 'SIGTERM');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  if (await waitForTermination(child, terminated, gracefulTimeoutMs(), () => options.cleanupDeadline ?? Number.POSITIVE_INFINITY)) return;
  if (childHasExited(child)) {
    if (options.posixExitCleanup) {
      await options.posixExitCleanup(options.cleanupDeadline);
      return;
    }
    throw new Error(`Chromium main process ${pid} exited before forced cleanup; refusing to signal a potentially reused process group`);
  }
  try {
    signalGroup(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  if (!await waitForTermination(child, terminated, forceTimeoutMs(), () => options.cleanupDeadline ?? Number.POSITIVE_INFINITY)) {
    throw new Error(`Chromium process group ${pid} did not exit after SIGKILL`);
  }
}

export async function terminateFailedChromiumLaunch(
  child: ChildProcess,
  options: ProcessTerminationOptions,
  windowsRootIdentityPromise?: Promise<WindowsProcessRecord>,
): Promise<void> {
  let terminationOptions = options;
  let identityFailure: unknown;
  if (windowsRootIdentityPromise && !terminationOptions.windowsRootIdentity) {
    try {
      terminationOptions = { ...terminationOptions, windowsRootIdentity: await windowsRootIdentityPromise };
    } catch (error) {
      identityFailure = error;
    }
  }
  try {
    // Identity capture failure must never skip immediate cleanup. While the tracked
    // ChildProcess is still live, its PID is safe for the Windows launch-failure
    // taskkill fallback; after exit, terminateProcessTree deliberately fails closed.
    await terminateProcessTree(child, terminationOptions);
  } catch (terminationError) {
    if (identityFailure !== undefined) {
      throw new AggregateError([identityFailure, terminationError], 'Windows launch identity capture and process termination failed');
    }
    throw terminationError;
  }
  if (identityFailure !== undefined) throw identityFailure;
}

export async function closeChromiumResources(
  browser: Pick<Browser, 'close'> & Partial<Pick<Browser, 'newBrowserCDPSession'>>,
  child: ChildProcess,
  options: ProcessTerminationOptions & { browserCloseTimeoutMs?: number; shutdownTimeoutMs?: number } = {},
): Promise<void> {
  const browserCloseTimeoutMs = options.browserCloseTimeoutMs ?? 3_000;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 3_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 3_000;
  const cleanupDeadline = Math.min(
    options.cleanupDeadline ?? Number.POSITIVE_INFINITY,
    Date.now() + (options.shutdownTimeoutMs ?? browserCloseTimeoutMs + gracefulTimeoutMs + forceTimeoutMs),
  );
  const scopedOptions: ProcessTerminationOptions = { ...options, cleanupDeadline };
  const stageTimeout = (fallback: number, stage: string): number => boundedCleanupTimeout(scopedOptions, fallback, stage);

  if ((options.platform ?? process.platform) === 'win32') {
    const pid = validatedPid(child);
    if (pid === undefined) {
      try {
        await withTimeout(requestChromiumShutdown(browser), stageTimeout(browserCloseTimeoutMs, 'browser close'), 'Chromium browser close');
      } catch { /* force cleanup below */ }
      await terminateProcessTree(child, scopedOptions);
      return;
    }
    if (childHasExited(child) && scopedOptions.windowsExitCleanup) {
      try {
        await withTimeout(requestChromiumShutdown(browser), stageTimeout(browserCloseTimeoutMs, 'browser disconnect'), 'Chromium browser disconnect');
      } catch { /* the child-exit tracker is authoritative */ }
      await withTimeout(
        scopedOptions.windowsExitCleanup(cleanupDeadline),
        stageTimeout(forceTimeoutMs, 'Windows child-exit cleanup'),
        'Windows Chromium child-exit cleanup',
      );
      return;
    }
    let snapshot: WindowsProcessTreeSnapshot;
    try {
      if (!options.windowsRootIdentity) throw new Error('Windows Chromium launch-time process identity is unavailable');
      snapshot = captureWindowsProcessTree(
        pid,
        await listWindowsProcesses(scopedOptions, stageTimeout(forceTimeoutMs, 'Windows process enumeration')),
        options.windowsRootIdentity,
      );
    } catch (error) {
      // Give Chromium a chance to flush its profile even though tree verification is
      // unavailable, then fail closed so the manager retains the profile lease.
      try {
        await withTimeout(requestChromiumShutdown(browser), stageTimeout(browserCloseTimeoutMs, 'browser close'), 'Chromium browser close');
      } catch { /* retain the identity-capture failure below */ }
      if (!childHasExited(child)) {
        try {
          await taskkillWindowsPid(pid, scopedOptions, stageTimeout(forceTimeoutMs, 'identity-safe immediate taskkill'));
          if (!await waitForTermination(
            child,
            () => childHasExited(child),
            stageTimeout(forceTimeoutMs, 'main-process exit verification'),
            () => cleanupDeadline,
          )) {
            throw new Error(`Chromium main process ${pid} did not report exit after identity-safe immediate taskkill`);
          }
        } catch (terminationError) {
          throw new AggregateError([error, terminationError], 'Windows Chromium identity capture and immediate cleanup failed');
        }
      }
      throw error;
    }
    let gracefulCloseCompleted = true;
    try {
      await withTimeout(requestChromiumShutdown(browser), stageTimeout(browserCloseTimeoutMs, 'browser close'), 'Chromium browser close');
    } catch {
      gracefulCloseCompleted = false;
    }
    if (gracefulCloseCompleted && !childHasExited(child)) {
      await waitForTermination(
        child,
        () => childHasExited(child),
        stageTimeout(gracefulTimeoutMs, 'graceful main-process exit'),
        () => cleanupDeadline,
      );
    }
    if (childHasExited(child) && scopedOptions.windowsExitCleanup) {
      await withTimeout(
        scopedOptions.windowsExitCleanup(cleanupDeadline),
        stageTimeout(forceTimeoutMs, 'Windows child-exit cleanup'),
        'Windows Chromium child-exit cleanup',
      );
      return;
    }
    const survivors = windowsTreeSurvivors(
      snapshot,
      await listWindowsProcesses(scopedOptions, stageTimeout(forceTimeoutMs, 'Windows survivor enumeration')),
    );
    if (childHasExited(child) && survivors.length === 0) return;
    await forceWindowsProcessTree(child, snapshot, scopedOptions);
    scopedOptions.windowsExitCleanup?.markVerified();
    if (scopedOptions.windowsExitCleanup) {
      await withTimeout(
        scopedOptions.windowsExitCleanup(cleanupDeadline),
        stageTimeout(forceTimeoutMs, 'Windows exit-tracker join'),
        'Windows Chromium exit-tracker join',
      ).catch(() => undefined);
    }
  } else {
    let gracefulCloseCompleted = true;
    try {
      await withTimeout(requestChromiumShutdown(browser), stageTimeout(browserCloseTimeoutMs, 'browser close'), 'Chromium browser close');
    } catch {
      gracefulCloseCompleted = false;
    }
    if (gracefulCloseCompleted && !childHasExited(child)) {
      await waitForTermination(
        child,
        () => childHasExited(child),
        stageTimeout(gracefulTimeoutMs, 'graceful main-process exit'),
        () => cleanupDeadline,
      );
    }
    await terminateProcessTree(child, scopedOptions);
  }
}

export async function launchChromium(options: {
  executablePath?: string;
  userDataDir: string;
  proxyUrl: string;
  headless: boolean;
  viewport?: { width: number; height: number };
  locale?: string;
  logger: Logger;
}): Promise<ChromiumProcess> {
  const allowNoSandbox = process.env.TENDRIL_ALLOW_NO_SANDBOX === 'true';
  if (process.getuid?.() === 0 && !allowNoSandbox) {
    throw new TendrilError('BROWSER_LAUNCH_FAILED', 'Tendril refuses to launch Chromium as root. Run as a non-root user.');
  }
  const executablePath = await findChromium(options.executablePath);
  await ensureDir(options.userDataDir);
  const activePortPath = pathWithinOwnedRoot(options.userDataDir, 'DevToolsActivePort');
  // activePortPath is a fixed basename beneath the manager-owned session/profile directory.
  // lgtm[js/path-injection]
  await unlink(activePortPath).catch((error) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  });
  // Chromium's crash handler consults HOME even when crash reporting is disabled.
  // Keep every browser-owned path inside the session/profile so read-only hosts and
  // containers never require a writable system home directory.
  const browserHome = pathWithinOwnedRoot(options.userDataDir, '.tendril-home');
  const browserConfigHome = pathWithinOwnedRoot(browserHome, '.config');
  const browserCacheHome = pathWithinOwnedRoot(browserHome, '.cache');
  await Promise.all([ensureDir(browserHome), ensureDir(browserConfigHome), ensureDir(browserCacheHome)]);
  const args = [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${options.userDataDir}`,
    `--proxy-server=${options.proxyUrl}`,
    '--proxy-bypass-list=<-loopback>',
    '--no-startup-window',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-quic',
    '--disable-extensions',
    '--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,WebTransport',
    '--disable-sync',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--window-size=${options.viewport?.width ?? 1280},${options.viewport?.height ?? 800}`,
  ];
  if (options.headless) args.unshift('--headless=new');
  if (process.getuid?.() === 0 || allowNoSandbox) args.unshift('--no-sandbox');

  const stderr: string[] = [];
  const child = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HOME: browserHome,
      XDG_CONFIG_HOME: browserConfigHome,
      XDG_CACHE_HOME: browserCacheHome,
    },
  });
  const windowsLaunchSnapshotPromise = process.platform === 'win32'
    ? captureWindowsLaunchProcessTree(child, () => listWindowsProcesses({}, 12_000))
    : undefined;
  const windowsRootIdentityPromise = windowsLaunchSnapshotPromise?.then((snapshot) => snapshot.root);
  const windowsExitCleanup = windowsLaunchSnapshotPromise
    ? trackWindowsProcessTree(child, windowsLaunchSnapshotPromise)
    : undefined;
  void windowsLaunchSnapshotPromise?.catch(() => undefined);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr.push(chunk);
    if (stderr.join('').length > 16_384) stderr.shift();
  });
  const posixExitCleanup = process.platform === 'win32' ? undefined : trackPosixProcessGroup(child);
  let terminationOptions: ProcessTerminationOptions = posixExitCleanup
    ? { posixExitCleanup }
    : windowsExitCleanup ? { windowsExitCleanup } : {};
  void windowsRootIdentityPromise?.catch(() => undefined);

  try {
    const endpoint = await waitForDevTools(options.userDataDir, child);
    if (windowsLaunchSnapshotPromise) {
      try {
        const snapshot = await windowsLaunchSnapshotPromise;
        terminationOptions = {
          windowsRootIdentity: snapshot.root,
          windowsExitCleanup: windowsExitCleanup!,
        };
      } catch (error) {
        // The identity snapshot only improves cleanup verification. A cold or
        // loaded Windows runner can exceed the enumeration budget, and a failed
        // snapshot must never fail a successfully launched browser: fall back to
        // direct termination (closeChromiumResources handles the missing
        // identity with browser close + taskkill).
        options.logger.warn('Windows launch process-tree snapshot failed; using direct termination fallback', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chromium did not expose a default browser context');
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);
    // Some TypeScript-on-the-fly loaders wrap nested browser functions with this harmless helper.
    // Defining it in pages keeps development and packaged builds behaviorally identical.
    await context.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((target) => target);' });
    // --no-startup-window prevents a delayed platform-created tab from racing
    // this deterministic initial page (most notably on Windows).
    if (context.pages().length === 0) await context.newPage();
    for (const page of context.pages()) {
      await page.evaluate('globalThis.__name = globalThis.__name || ((target) => target);').catch(() => undefined);
    }
    if (options.locale) await context.setExtraHTTPHeaders({ 'Accept-Language': options.locale });
    options.logger.info('Chromium session started', { pid: child.pid, cdpPort: endpoint.port });
    let closePromise: Promise<void> | undefined;
    return {
      browser,
      context,
      child,
      cdpPort: endpoint.port,
      browserPath: endpoint.browserPath,
      userDataDir: options.userDataDir,
      async close() {
        if (!closePromise) {
          closePromise = closeChromiumResources(browser, child, terminationOptions);
        }
        return closePromise;
      },
    };
  } catch (error) {
    try {
      await terminateFailedChromiumLaunch(child, terminationOptions, windowsRootIdentityPromise);
    } catch (terminationError) {
      throw new TendrilError('BROWSER_LAUNCH_FAILED', `Unable to launch Chromium: ${stderr.join('').slice(-4000)}`, {
        cause: new AggregateError([error, terminationError], 'Chromium launch failed and process termination was not verified'),
        details: { browserTerminationVerified: false },
      });
    }
    throw new TendrilError('BROWSER_LAUNCH_FAILED', `Unable to launch Chromium: ${stderr.join('').slice(-4000)}`, { cause: error });
  }
}
