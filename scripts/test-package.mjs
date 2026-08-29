import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'tendril-package-'));

try {
  const { stdout } = await execFileAsync('npm', ['pack', '--json', '--pack-destination', temporaryRoot], {
    cwd: projectRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  const [{ filename, files }] = JSON.parse(stdout);
  const fileNames = new Set(files.map((entry) => entry.path));
  const sourceFiles = (await readdir(path.join(projectRoot, 'src'), { recursive: true }))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/${name.split(path.sep).join('/')}`);

  for (const source of sourceFiles) {
    const relative = source.slice('src/'.length).replace(/\.ts$/, '');
    for (const suffix of ['.js', '.js.map', '.d.ts']) {
      const expected = `dist/${relative}${suffix}`;
      if (!fileNames.has(expected)) throw new Error(`Packed artifact is missing ${expected}`);
    }
  }

  for (const fileName of fileNames) {
    if (!fileName.startsWith('dist/') || !/\.(?:js|js\.map|d\.ts)$/.test(fileName)) continue;
    const relative = fileName.slice('dist/'.length).replace(/(?:\.js\.map|\.d\.ts|\.js)$/, '.ts');
    if (!sourceFiles.includes(`src/${relative}`)) throw new Error(`Packed artifact has no source counterpart: ${fileName}`);
  }

  const consumer = path.join(temporaryRoot, 'consumer');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'tendril-consumer-smoke', private: true, type: 'module' }));
  await execFileAsync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporaryRoot, filename)], { cwd: consumer });

  const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const imported = await execFileAsync('node', ['--input-type=module', '--eval', "import('project-tendril').then(m => { if (!m.createRuntime) process.exit(2); })"], { cwd: consumer });
  if (imported.stderr) process.stderr.write(imported.stderr);
  const cli = await execFileAsync(process.execPath, [path.join(consumer, 'node_modules/project-tendril/dist/cli.js'), '--version'], { cwd: consumer });
  if (cli.stdout.trim() !== packageMetadata.version) {
    throw new Error(`CLI version ${cli.stdout.trim()} does not match package ${packageMetadata.version}`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
