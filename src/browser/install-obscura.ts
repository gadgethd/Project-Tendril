import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { TendrilError } from '../errors.js';
import { ensureDir } from '../util.js';

const execFileAsync = promisify(execFile);
export const OBSCURA_VERSION = '0.2.1';

const RELEASES: Record<string, { asset: string; sha256: string }> = {
  'linux-x64': { asset: 'obscura-x86_64-linux-stealth.tar.gz', sha256: '49856870420960ce489d2d1ff40fffac5b8c016604b9af0ded8ed6373abd9302' },
  'linux-arm64': { asset: 'obscura-aarch64-linux-stealth.tar.gz', sha256: '77704cf11a0a4f4849d93501e1f2a3ff09ca62e2700049ac9c6e83922b86828a' },
  'darwin-x64': { asset: 'obscura-x86_64-macos-stealth.tar.gz', sha256: 'c28abc9216fd8fbe0516219ad259008c2b13e8d35bf399f9647e9775f8d9d2a6' },
  'darwin-arm64': { asset: 'obscura-aarch64-macos-stealth.tar.gz', sha256: 'c20008431f96879ab5d73f3d5e0cc5c45bdb85add523ccd34ac9df75bb6703f8' },
  'win32-x64': { asset: 'obscura-x86_64-windows-stealth.zip', sha256: '05872180fd4c5bbb765e232b0d3bb3b183b47aaa25699dc017d622278a59d597' },
};

export async function installObscura(destination: string): Promise<string> {
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) {
    throw new TendrilError('UNSUPPORTED_OPERATION', `No Obscura ${OBSCURA_VERSION} binary is published for ${process.platform}/${process.arch}`);
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'tendril-obscura-install-'));
  try {
    const url = `https://github.com/h4ckf0r0day/obscura/releases/download/v${OBSCURA_VERSION}/${release.asset}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
    const archive = path.join(temporary, release.asset);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    const digest = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    if (digest !== release.sha256) throw new Error(`Checksum mismatch for ${release.asset}`);
    await execFileAsync('tar', ['-xf', archive, '-C', temporary]);
    const executableName = process.platform === 'win32' ? 'obscura.exe' : 'obscura';
    await ensureDir(path.dirname(destination));
    await copyFile(path.join(temporary, executableName), destination);
    if (process.platform !== 'win32') await chmod(destination, 0o755);
    return destination;
  } catch (error) {
    throw new TendrilError('BROWSER_LAUNCH_FAILED', `Unable to install Obscura ${OBSCURA_VERSION}`, { cause: error });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
