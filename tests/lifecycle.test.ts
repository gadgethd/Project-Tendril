import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  captureExitedWindowsProcessTree,
  captureWindowsLaunchProcessTree,
  captureWindowsProcessTree,
  closeChromiumResources,
  launchChromium,
  runBoundedHelper,
  terminateFailedChromiumLaunch,
  terminateProcessTree,
  trackPosixProcessGroup,
  trackWindowsProcessTree,
  WINDOWS_PROCESS_LIST_SCRIPT,
  windowsTaskkillArguments,
} from '../src/browser/chromium.js';
import { TendrilSession } from '../src/browser/session.js';
import { Logger } from '../src/util.js';

describe('runtime resource cleanup', () => {
  async function runNodeProbe(source: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const watchdog = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Node probe did not exit: ${stdout}${stderr}`));
      }, 5_000);
      child.once('error', (error) => {
        clearTimeout(watchdog);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(watchdog);
        resolve({ code, stdout, stderr });
      });
    });
  }

  function fakeChild(pid = 42): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    return child;
  }

  function createdAt(offsetMs: number): string {
    return new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString();
  }

  it('captures a maximum-size reversed Windows process chain in linear time and rejects duplicate PIDs', () => {
    expect(WINDOWS_PROCESS_LIST_SCRIPT).toContain('ProcessId -gt 0');
    const rootPid = 100_000;
    const records = Array.from({ length: 65_536 }, (_value, index) => ({
      pid: rootPid + index,
      parentPid: index === 0 ? 1 : rootPid + index - 1,
      creationDate: createdAt(index),
    })).reverse();
    const snapshot = captureWindowsProcessTree(rootPid, records, {
      pid: rootPid,
      parentPid: 1,
      creationDate: createdAt(0),
    });
    expect(snapshot.descendants).toHaveLength(65_535);
    expect(() =>
      captureWindowsProcessTree(rootPid, [
        { pid: rootPid, parentPid: 1, creationDate: createdAt(0) },
        { pid: rootPid, parentPid: 2, creationDate: createdAt(1) },
      ]),
    ).toThrow('duplicate PID');
    expect(() =>
      captureWindowsProcessTree(rootPid, [
        { pid: rootPid, parentPid: 1, creationDate: createdAt(10) },
        { pid: rootPid + 1, parentPid: rootPid, creationDate: createdAt(5) },
      ]),
    ).toThrow('predates its reported parent');
  });

  it('uses verified platform-specific process-tree termination strategies', async () => {
    expect(windowsTaskkillArguments(202)).toEqual(['/PID', '202', '/T', '/F']);
    expect(() => windowsTaskkillArguments(Number.NaN)).toThrow('invalid PID');
    const posixChild = fakeChild(101);
    let posixAlive = true;
    const signals: NodeJS.Signals[] = [];
    await terminateProcessTree(posixChild, {
      platform: 'linux',
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 100,
      posixGroupAlive: () => posixAlive,
      signalPosixGroup: (_pid, signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') {
          posixAlive = false;
          Object.assign(posixChild, { signalCode: 'SIGKILL' });
          posixChild.emit('exit', null, 'SIGKILL');
        }
      },
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);

    const windowsChild = fakeChild(202);
    let windowsProcesses = [{ pid: 202, parentPid: 1, creationDate: createdAt(0) }];
    const taskkill = vi.fn(async (pid: number) => {
      expect(pid).toBe(202);
      windowsProcesses = [];
      Object.assign(windowsChild, { exitCode: 1 });
      windowsChild.emit('exit', 1, null);
    });
    await terminateProcessTree(windowsChild, {
      platform: 'win32',
      taskkill,
      forceTimeoutMs: 100,
      windowsProcessList: async () => windowsProcesses,
      windowsRootIdentity: { pid: 202, parentPid: 1, creationDate: createdAt(0) },
    });
    expect(taskkill).toHaveBeenCalledOnce();
  });

  it('never signals a cached POSIX process group after the main PID was observed exited', async () => {
    const child = fakeChild(250);
    Object.assign(child, { exitCode: 0 });
    const signalPosixGroup = vi.fn();
    await expect(
      terminateProcessTree(child, {
        platform: 'linux',
        signalPosixGroup,
        posixGroupAlive: () => true,
      }),
    ).rejects.toThrow('potentially reused process group');
    expect(signalPosixGroup).not.toHaveBeenCalled();
  });

  it('captures POSIX group-probe errors without throwing from the child exit listener', async () => {
    const child = fakeChild(260);
    const cleanup = trackPosixProcessGroup(child, {
      posixGroupAlive: () => {
        throw Object.assign(new Error('probe denied'), { code: 'EPERM' });
      },
    });
    Object.assign(child, { exitCode: 1 });
    expect(() => child.emit('exit', 1, null)).not.toThrow();
    await expect(cleanup()).rejects.toThrow('probe denied');
  });

  it('allows a delayed graceful POSIX CDP exit without sending SIGTERM', async () => {
    const child = fakeChild(275);
    let groupAlive = true;
    const signalPosixGroup = vi.fn();
    const posixExitCleanup = trackPosixProcessGroup(child, {
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 100,
      posixGroupAlive: () => groupAlive,
      signalPosixGroup,
    });
    const browserClose = vi.fn(async () => {
      setTimeout(() => {
        groupAlive = false;
        Object.assign(child, { exitCode: 0 });
        child.emit('exit', 0, null);
      }, 25);
    });
    await closeChromiumResources({ close: browserClose }, child, {
      platform: 'linux',
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 100,
      posixGroupAlive: () => groupAlive,
      signalPosixGroup,
      posixExitCleanup,
    });
    expect(signalPosixGroup).not.toHaveBeenCalled();
  });

  it('closes a Windows process tree gracefully before using identity-checked taskkill', async () => {
    const child = fakeChild(301);
    let processes = [
      { pid: 301, parentPid: 1, creationDate: createdAt(0) },
      { pid: 302, parentPid: 301, creationDate: createdAt(1) },
    ];
    const taskkill = vi.fn(async () => undefined);
    const browserClose = vi.fn(async () => undefined);
    const cdpSend = vi.fn(async (method: string) => {
      expect(method).toBe('Browser.close');
      processes = [];
      Object.assign(child, { exitCode: 0 });
      child.emit('exit', 0, null);
    });
    await closeChromiumResources(
      {
        close: browserClose,
        newBrowserCDPSession: vi.fn(async () => ({ send: cdpSend }) as never),
      },
      child,
      {
        platform: 'win32',
        taskkill,
        windowsProcessList: async () => processes,
        forceTimeoutMs: 100,
        windowsRootIdentity: { pid: 301, parentPid: 1, creationDate: createdAt(0) },
      },
    );
    expect(browserClose).toHaveBeenCalledOnce();
    expect(cdpSend).toHaveBeenCalledWith('Browser.close');
    expect(taskkill).not.toHaveBeenCalled();
  });

  it('joinably cleans launch-identified Windows descendants after an unexpected main exit', async () => {
    const child = fakeChild(901);
    const launchSnapshot = captureWindowsProcessTree(901, [
      { pid: 901, parentPid: 1, creationDate: createdAt(0) },
      { pid: 902, parentPid: 901, creationDate: createdAt(1) },
    ]);
    let processes = [
      { pid: 901, parentPid: 1, creationDate: new Date(Date.now() + 5_000).toISOString() },
      { pid: 902, parentPid: 1, creationDate: createdAt(1) },
    ];
    const taskkill = vi.fn(async (pid: number) => {
      expect(pid).toBe(902);
      processes = processes.filter((record) => record.pid !== pid);
    });
    const cleanup = trackWindowsProcessTree(child, Promise.resolve(launchSnapshot), {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 200,
      windowsProcessList: async () => processes,
      taskkill,
    });
    Object.assign(child, { exitCode: 1 });
    child.emit('exit', 1, null);
    await cleanup(Date.now() + 500);
    expect(taskkill).toHaveBeenCalledOnce();
    expect(taskkill).not.toHaveBeenCalledWith(901);

    expect(() =>
      captureExitedWindowsProcessTree(
        launchSnapshot,
        [
          { pid: 901, parentPid: 1, creationDate: createdAt(0) },
          { pid: 903, parentPid: 901, creationDate: new Date(Date.parse(createdAt(0)) - 1).toISOString() },
        ],
        Date.now(),
      ),
    ).toThrow('predates its reported parent');
  });

  it('never captures or taskkills children of a reused Windows root PID', async () => {
    const launchSnapshot = captureWindowsProcessTree(901, [{ pid: 901, parentPid: 1, creationDate: createdAt(0) }]);
    const reusedTree = [
      { pid: 901, parentPid: 1, creationDate: createdAt(10) },
      { pid: 903, parentPid: 901, creationDate: createdAt(11) },
    ];
    const captured = captureExitedWindowsProcessTree(launchSnapshot, reusedTree, Date.parse(createdAt(20)));
    expect(captured.descendants).toEqual([]);

    const child = fakeChild(901);
    const taskkill = vi.fn(async () => undefined);
    const cleanup = trackWindowsProcessTree(child, Promise.resolve(launchSnapshot), {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 100,
      windowsProcessList: async () => reusedTree,
      taskkill,
    });
    Object.assign(child, { exitCode: 1 });
    child.emit('exit', 1, null);
    await cleanup(Date.now() + 250);
    expect(taskkill).not.toHaveBeenCalled();
  });

  it('never captures or taskkills an orphan child after a reused Windows root exits', async () => {
    const launchSnapshot = captureWindowsProcessTree(901, [{ pid: 901, parentPid: 1, creationDate: createdAt(0) }]);
    // PID 901 was reused at t6, spawned 903 at t7, then exited at t8. The
    // orphan retains numeric PPID 901 even though neither root identity exists.
    const orphanedReusedTree = [{ pid: 903, parentPid: 901, creationDate: createdAt(7) }];
    const captured = captureExitedWindowsProcessTree(launchSnapshot, orphanedReusedTree, Date.parse(createdAt(9)));
    expect(captured.descendants).toEqual([]);

    const child = fakeChild(901);
    const taskkill = vi.fn(async () => undefined);
    const cleanup = trackWindowsProcessTree(child, Promise.resolve(launchSnapshot), {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 100,
      windowsProcessList: async () => orphanedReusedTree,
      taskkill,
    });
    Object.assign(child, { exitCode: 1 });
    child.emit('exit', 1, null);
    await cleanup(Date.now() + 250);
    expect(taskkill).not.toHaveBeenCalled();
  });

  it('retains a valid Windows launch snapshot when the main process exits after enumeration', async () => {
    const child = fakeChild(921);
    let resolveProcesses!: (records: Array<{ pid: number; parentPid: number; creationDate: string }>) => void;
    const processes = new Promise<Array<{ pid: number; parentPid: number; creationDate: string }>>((resolve) => {
      resolveProcesses = resolve;
    });
    const pending = captureWindowsLaunchProcessTree(child, () => processes);
    Object.assign(child, { exitCode: 1 });
    resolveProcesses([
      { pid: 921, parentPid: 1, creationDate: createdAt(0) },
      { pid: 922, parentPid: 921, creationDate: createdAt(1) },
    ]);
    await expect(pending).resolves.toEqual({
      root: { pid: 921, parentPid: 1, creationDate: createdAt(0) },
      descendants: [{ pid: 922, parentPid: 921, creationDate: createdAt(1) }],
    });
  });

  it('force-kills a verified Windows tree after graceful close times out', async () => {
    const child = fakeChild(401);
    let processes = [
      { pid: 401, parentPid: 1, creationDate: createdAt(0) },
      { pid: 402, parentPid: 401, creationDate: createdAt(1) },
    ];
    const taskkill = vi.fn(async (pid: number) => {
      expect(pid).toBe(401);
      processes = [];
      Object.assign(child, { signalCode: 'SIGKILL' });
      child.emit('exit', null, 'SIGKILL');
    });
    await closeChromiumResources({ close: () => new Promise(() => {}) }, child, {
      platform: 'win32',
      taskkill,
      windowsProcessList: async () => processes,
      browserCloseTimeoutMs: 10,
      forceTimeoutMs: 100,
      windowsRootIdentity: { pid: 401, parentPid: 1, creationDate: createdAt(0) },
    });
    expect(taskkill).toHaveBeenCalledOnce();
  });

  it('applies one wall-clock deadline to concurrent Windows force cleanup', async () => {
    const child = fakeChild(451);
    const original = [
      { pid: 451, parentPid: 1, creationDate: createdAt(0) },
      ...Array.from({ length: 8 }, (_value, index) => ({
        pid: 452 + index,
        parentPid: index === 0 ? 451 : 451 + index,
        creationDate: createdAt(index + 1),
      })),
    ];
    let calls = 0;
    const windowsProcessList = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return original;
      return original.map((record) => (record.pid === 451 ? record : { ...record, parentPid: 1 }));
    });
    const started = Date.now();
    await expect(
      closeChromiumResources(
        {
          close: vi.fn(async () => {
            throw new Error('close failed');
          }),
        },
        child,
        {
          platform: 'win32',
          taskkill: () => new Promise(() => {}),
          windowsProcessList,
          forceTimeoutMs: 80,
          windowsRootIdentity: original[0],
        },
      ),
    ).rejects.toThrow(/deadline|terminate/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('kills a captured Windows descendant but never a reused main PID', async () => {
    const child = fakeChild(501);
    let processes = [
      { pid: 501, parentPid: 1, creationDate: createdAt(0) },
      { pid: 502, parentPid: 501, creationDate: createdAt(1) },
    ];
    const taskkill = vi.fn(async (pid: number) => {
      expect(pid).toBe(502);
      processes = [{ pid: 501, parentPid: 1, creationDate: createdAt(10) }];
    });
    await closeChromiumResources(
      {
        close: vi.fn(async () => {
          Object.assign(child, { exitCode: 0 });
          child.emit('exit', 0, null);
          processes = [
            { pid: 501, parentPid: 1, creationDate: createdAt(10) },
            { pid: 502, parentPid: 1, creationDate: createdAt(1) },
          ];
        }),
      },
      child,
      {
        platform: 'win32',
        taskkill,
        windowsProcessList: async () => processes,
        forceTimeoutMs: 100,
        windowsRootIdentity: { pid: 501, parentPid: 1, creationDate: createdAt(0) },
      },
    );
    expect(taskkill).toHaveBeenCalledOnce();
    expect(taskkill).toHaveBeenCalledWith(502);
  });

  it('fails closed without taskkill when the Windows main PID was reused before cleanup', async () => {
    const child = fakeChild(601);
    Object.assign(child, { exitCode: 0 });
    const taskkill = vi.fn(async () => undefined);
    const browserClose = vi.fn(async () => undefined);
    await expect(
      closeChromiumResources({ close: browserClose }, child, {
        platform: 'win32',
        taskkill,
        windowsProcessList: async () => [{ pid: 601, parentPid: 1, creationDate: createdAt(10) }],
        windowsRootIdentity: { pid: 601, parentPid: 1, creationDate: createdAt(0) },
        forceTimeoutMs: 100,
      }),
    ).rejects.toThrow('no longer has its launch-time process identity');
    expect(browserClose).toHaveBeenCalledOnce();
    expect(taskkill).not.toHaveBeenCalled();
  });

  it('immediately taskkills a still-live Windows launch when identity enumeration failed', async () => {
    const child = fakeChild(701);
    const taskkill = vi.fn(async () => {
      Object.assign(child, { signalCode: 'SIGKILL' });
      child.emit('exit', null, 'SIGKILL');
    });
    await expect(
      terminateProcessTree(child, {
        platform: 'win32',
        taskkill,
        forceTimeoutMs: 100,
      }),
    ).rejects.toThrow('could not be identity-verified');
    expect(taskkill).toHaveBeenCalledWith(701);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('does not let a rejected Windows identity promise skip live launch cleanup', async () => {
    const child = fakeChild(711);
    const taskkill = vi.fn(async () => {
      Object.assign(child, { signalCode: 'SIGKILL' });
      child.emit('exit', null, 'SIGKILL');
    });
    await expect(
      terminateFailedChromiumLaunch(child, { platform: 'win32', taskkill, forceTimeoutMs: 100 }, Promise.reject(new Error('injected CIM identity failure'))),
    ).rejects.toThrow('identity capture and process termination failed');
    expect(taskkill).toHaveBeenCalledWith(711);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('clears the browser-close timeout immediately after a fast close', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      Object.assign(child, { exitCode: 0 });
      await closeChromiumResources({ close: vi.fn(async () => undefined) }, child, {
        platform: 'linux',
        posixGroupAlive: () => false,
        posixExitCleanup: async () => undefined,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cleanup watchdogs referenced until timeout and process-tree verification settle', async () => {
    const utilUrl = pathToFileURL(path.resolve('src/util.ts')).href;
    const timeoutProbe = await runNodeProbe(`
      import { withTimeout } from ${JSON.stringify(utilUrl)};
      const started = Date.now();
      process.once('beforeExit', () => console.log('BEFORE_EXIT', Date.now() - started));
      void withTimeout(new Promise(() => {}), 100, 'probe')
        .then(() => console.log('RESOLVED'))
        .catch((error) => console.log('REJECTED', error.code, Date.now() - started));
    `);
    expect(timeoutProbe.code, timeoutProbe.stderr).toBe(0);
    expect(timeoutProbe.stdout.indexOf('REJECTED TIMEOUT')).toBeGreaterThanOrEqual(0);
    expect(timeoutProbe.stdout.indexOf('REJECTED TIMEOUT')).toBeLessThan(timeoutProbe.stdout.indexOf('BEFORE_EXIT'));
    const timeoutElapsed = Number(/REJECTED TIMEOUT (\d+)/.exec(timeoutProbe.stdout)?.[1]);
    expect(timeoutElapsed).toBeGreaterThanOrEqual(75);

    const chromiumUrl = pathToFileURL(path.resolve('src/browser/chromium.ts')).href;
    const terminationProbe = await runNodeProbe(`
      import { EventEmitter } from 'node:events';
      import { terminateProcessTree } from ${JSON.stringify(chromiumUrl)};
      const child = Object.assign(new EventEmitter(), { pid: 101, exitCode: null, signalCode: null, kill: () => true });
      const started = Date.now();
      process.once('beforeExit', () => console.log('BEFORE_EXIT', Date.now() - started));
      void terminateProcessTree(child, {
        platform: 'linux', gracefulTimeoutMs: 100, forceTimeoutMs: 100,
        posixGroupAlive: () => true, signalPosixGroup: () => {},
      }).then(() => console.log('RESOLVED'))
        .catch((error) => console.log('REJECTED', Date.now() - started, error.message));
    `);
    expect(terminationProbe.code, terminationProbe.stderr).toBe(0);
    expect(terminationProbe.stdout).toContain('did not exit after SIGKILL');
    expect(terminationProbe.stdout.indexOf('REJECTED')).toBeLessThan(terminationProbe.stdout.indexOf('BEFORE_EXIT'));
    const terminationElapsed = Number(/REJECTED (\d+)/.exec(terminationProbe.stdout)?.[1]);
    expect(terminationElapsed).toBeGreaterThanOrEqual(175);
  });

  it('kills and joins a hung Windows helper subprocess at its internal deadline', async () => {
    const started = Date.now();
    await expect(runBoundedHelper(process.execPath, ['--eval', 'setInterval(() => {}, 10_000)'], { timeoutMs: 75 })).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('fails within the helper deadline when a killed helper never emits close', async () => {
    vi.useFakeTimers();
    try {
      const helper = new EventEmitter() as ChildProcess;
      Object.assign(helper, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
        unref: vi.fn(),
      });
      const pending = runBoundedHelper('stuck-helper', [], {
        timeoutMs: 50,
        postKillJoinTimeoutMs: 20,
        spawnProcess: (() => helper) as typeof spawn,
      });
      const expectation = expect(pending).rejects.toThrow('did not report exit after forced helper termination');
      await vi.advanceTimersByTimeAsync(60);
      await expectation;
      expect(helper.kill).toHaveBeenCalledWith('SIGKILL');
      expect(helper.unref).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one absolute deadline across Chromium close and forced tree cleanup', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(801);
      const identity = { pid: 801, parentPid: 1, creationDate: createdAt(0) };
      const taskkill = vi.fn(() => new Promise<void>(() => {}));
      const pending = closeChromiumResources({ close: () => new Promise(() => {}) }, child, {
        platform: 'win32',
        windowsRootIdentity: identity,
        windowsProcessList: async () => [identity],
        taskkill,
        browserCloseTimeoutMs: 60,
        gracefulTimeoutMs: 60,
        forceTimeoutMs: 60,
        shutdownTimeoutMs: 100,
      });
      const expectation = expect(pending).rejects.toThrow(/deadline|terminate/);
      await vi.advanceTimersByTimeAsync(150);
      await expectation;
      expect(taskkill).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes Chromium after post-launch session setup failure and reports unverified termination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-session-create-cleanup-'));
    const config = {
      actionTimeoutMs: 100,
      navigationTimeoutMs: 100,
      blockPrivateNetworks: true,
      allowedHosts: [],
      blockedHosts: [],
      headless: true,
      dataDir: path.join(root, 'data'),
      runtimeDir: path.join(root, 'run'),
    } as never;
    const chromiumClose = vi.fn(async () => {
      throw new Error('injected termination failure');
    });
    const launch = vi.fn(
      async () =>
        ({
          context: {
            setDefaultTimeout: vi.fn(() => {
              throw new Error('injected post-launch setup failure');
            }),
            setDefaultNavigationTimeout: vi.fn(),
            pages: vi.fn(() => []),
            on: vi.fn(),
          },
          close: chromiumClose,
        }) as never,
    );

    await expect(
      TendrilSession.create(
        {
          id: 'ses_post_launch_failure',
          userDataDir: path.join(root, 'run', 'sessions', 'ses_post_launch_failure'),
          createOptions: {},
          config,
          logger: new Logger('error'),
        },
        { launch },
      ),
    ).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_FAILED',
      details: { browserTerminationVerified: false },
    });
    expect(chromiumClose).toHaveBeenCalledOnce();
  });

  it('marks post-launch proxy cleanup failure as an unverified resource cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-session-proxy-cleanup-'));
    const config = {
      actionTimeoutMs: 100,
      navigationTimeoutMs: 100,
      blockPrivateNetworks: true,
      allowedHosts: [],
      blockedHosts: [],
      headless: true,
      dataDir: path.join(root, 'data'),
      runtimeDir: path.join(root, 'run'),
    } as never;
    const chromiumClose = vi.fn(async () => undefined);
    const proxyStop = vi.fn(async () => {
      throw new Error('injected proxy stop failure');
    });
    const proxy = {
      start: vi.fn(async () => undefined),
      stop: proxyStop,
      url: () => 'http://127.0.0.1:9',
    } as never;
    const launch = vi.fn(
      async () =>
        ({
          context: {
            setDefaultTimeout: vi.fn(() => {
              throw new Error('injected setup failure');
            }),
            setDefaultNavigationTimeout: vi.fn(),
            pages: vi.fn(() => []),
            on: vi.fn(),
          },
          close: chromiumClose,
        }) as never,
    );

    await expect(
      TendrilSession.create(
        {
          id: 'ses_proxy_cleanup_failure',
          userDataDir: path.join(root, 'run', 'sessions', 'ses_proxy_cleanup_failure'),
          createOptions: {},
          config,
          logger: new Logger('error'),
        },
        { launch, proxy },
      ),
    ).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_FAILED',
      details: { browserTerminationVerified: true, resourceCleanupVerified: false },
    });
    expect(chromiumClose).toHaveBeenCalledOnce();
    expect(proxyStop).toHaveBeenCalledOnce();
  });

  it('preserves caller-owned browser data and rejects a stale DevTools endpoint on launch failure', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'tendril-launch-persist-'));
    await writeFile(path.join(userDataDir, 'sentinel'), 'persistent state');
    await writeFile(path.join(userDataDir, 'DevToolsActivePort'), '65534\n/devtools/browser/stale\n');
    const previous = process.env.TENDRIL_ALLOW_NO_SANDBOX;
    process.env.TENDRIL_ALLOW_NO_SANDBOX = 'true';
    try {
      await expect(
        launchChromium({
          executablePath: process.execPath,
          userDataDir,
          proxyUrl: 'http://127.0.0.1:9',
          headless: true,
          logger: new Logger('error'),
        }),
      ).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' });
    } finally {
      if (previous === undefined) delete process.env.TENDRIL_ALLOW_NO_SANDBOX;
      else process.env.TENDRIL_ALLOW_NO_SANDBOX = previous;
    }
    expect(await readFile(path.join(userDataDir, 'sentinel'), 'utf8')).toBe('persistent state');
    await expect(access(path.join(userDataDir, 'DevToolsActivePort'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('attempts proxy and directory cleanup even when Chromium close fails', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'tendril-session-cleanup-'));
    await writeFile(path.join(userDataDir, 'sentinel'), 'temporary state');
    const chromiumClose = vi.fn(async () => {
      throw new Error('injected Chromium close failure');
    });
    const proxyStop = vi.fn(async () => undefined);
    const session = Object.create(TendrilSession.prototype) as TendrilSession;
    Object.assign(session as unknown as Record<string, unknown>, {
      id: 'ses_injected',
      profile: undefined,
      ephemeral: true,
      userDataDir,
      chromium: { close: chromiumClose },
      proxy: { stop: proxyStop },
      pendingDownloads: new Map(),
      logger: new Logger('error'),
    });

    const results = await Promise.allSettled([session.close(), session.close()]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(chromiumClose).toHaveBeenCalledTimes(1);
    expect(proxyStop).toHaveBeenCalledTimes(1);
    await expect(access(userDataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
