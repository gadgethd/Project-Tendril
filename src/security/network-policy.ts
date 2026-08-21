import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { TendrilError } from '../errors.js';

export interface NetworkPolicyOptions {
  blockPrivateNetworks: boolean;
  allowedHosts: string[];
  blockedHosts: string[];
}

export interface ResolvedDestination {
  hostname: string;
  address: string;
  family: 4 | 6;
  explicitlyAllowed: boolean;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function hostMatches(host: string, pattern: string): boolean {
  const normalizedHost = normalizeHost(host);
  const normalizedPattern = normalizeHost(pattern);
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
  }
  return normalizedHost === normalizedPattern;
}

export function isPrivateAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return true;
  }
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  const range = parsed.range();
  return !['unicast'].includes(range);
}

export class NetworkPolicy {
  readonly options: NetworkPolicyOptions;

  constructor(options: NetworkPolicyOptions) {
    this.options = options;
  }

  async resolve(rawUrl: string): Promise<ResolvedDestination> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      throw new TendrilError('INVALID_URL', `Invalid URL: ${rawUrl}`, { cause: error });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new TendrilError('NETWORK_BLOCKED', `Protocol ${url.protocol} is not allowed`);
    }
    if (url.username || url.password) {
      throw new TendrilError('NETWORK_BLOCKED', 'Credentials embedded in URLs are not allowed');
    }
    return this.resolveHost(url.hostname);
  }

  async resolveHost(rawHost: string): Promise<ResolvedDestination> {
    const hostname = normalizeHost(rawHost);
    if (this.options.blockedHosts.some((pattern) => hostMatches(hostname, pattern))) {
      throw new TendrilError('NETWORK_BLOCKED', `Host is blocked by policy: ${hostname}`);
    }
    const explicitlyAllowed = this.options.allowedHosts.some((pattern) => hostMatches(hostname, pattern));
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      if (!explicitlyAllowed && this.options.blockPrivateNetworks) {
        throw new TendrilError('NETWORK_BLOCKED', `Private host is blocked: ${hostname}`);
      }
    }

    let addresses: Array<{ address: string; family: 4 | 6 }>;
    if (ipaddr.isValid(hostname)) {
      addresses = [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }];
    } else {
      try {
        addresses = await dns.lookup(hostname, { all: true, verbatim: true }) as Array<{ address: string; family: 4 | 6 }>;
      } catch (error) {
        throw new TendrilError('NETWORK_BLOCKED', `DNS lookup failed for ${hostname}`, { cause: error, retryable: true });
      }
    }
    if (addresses.length === 0) throw new TendrilError('NETWORK_BLOCKED', `No addresses found for ${hostname}`);
    const permitted = addresses.filter((entry) => explicitlyAllowed || !this.options.blockPrivateNetworks || !isPrivateAddress(entry.address));
    if (permitted.length === 0) {
      throw new TendrilError('NETWORK_BLOCKED', `Host resolves only to blocked addresses: ${hostname}`);
    }
    const selected = permitted[0]!;
    return { hostname, address: selected.address, family: selected.family, explicitlyAllowed };
  }
}
