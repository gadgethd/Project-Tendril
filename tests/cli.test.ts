import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { acquireProfileFileLock } from '../src/browser/profile-lock.js';

const execFileAsync = promisify(execFile);

describe('profile CLI administration', () => {
  it('refuses to delete a profile while another process lease is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tendril-cli-profile-delete-'));
    const dataDir = path.join(root, 'data');
    const profileDir = path.join(dataDir, 'profiles', 'active');
    const configPath = path.join(root, 'config.json');
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'sentinel'), 'preserve while locked');
    await writeFile(configPath, JSON.stringify({ dataDir, runtimeDir: path.join(root, 'run') }));
    const lock = await acquireProfileFileLock(dataDir, 'active');
    const args = [
      '--import', 'tsx', path.resolve('src/cli.ts'), '--config', configPath, 'profiles', 'delete', 'active',
    ];

    let stderr = '';
    try {
      await execFileAsync(process.execPath, args, { cwd: process.cwd(), timeout: 15_000 });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? error);
    }
    expect(stderr).toContain('Profile is already active');
    expect(await readFile(path.join(profileDir, 'sentinel'), 'utf8')).toBe('preserve while locked');

    await lock.release();
    const deleted = await execFileAsync(process.execPath, args, { cwd: process.cwd(), timeout: 15_000 });
    expect(deleted.stdout).toContain('Deleted profile active');
    await expect(access(profileDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
