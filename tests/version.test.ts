import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

describe('release version contract', () => {
  it('uses package.json as the runtime version source', async () => {
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(metadata.version);
  });
});
