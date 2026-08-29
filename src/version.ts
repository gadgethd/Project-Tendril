import { readFileSync } from 'node:fs';

interface PackageMetadata {
  version?: unknown;
}

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageMetadata;

if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
  throw new Error('package.json contains an invalid version');
}

/** Canonical runtime version, loaded from the package metadata shipped beside dist/. */
export const VERSION = metadata.version;
export const USER_AGENT = `Project-Tendril/${VERSION}`;
