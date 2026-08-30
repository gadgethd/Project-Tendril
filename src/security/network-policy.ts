import { Resolver } from 'node:dns/promises';
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

interface ResolverLike {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}

export interface NetworkPolicyDependencies {
  createResolver?: () => ResolverLike;
  lookupTimeoutMs?: number;
}

interface ActiveLookup {
  cancel(): void;
  done: Promise<unknown>;
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
  private readonly createResolver: () => ResolverLike;
  private readonly lookupTimeoutMs: number;
  private readonly activeLookups = new Set<ActiveLookup>();
  private readonly closingController = new AbortController();
  private closePromise?: Promise<void>;

  constructor(options: NetworkPolicyOptions, dependencies: NetworkPolicyDependencies = {}) {
    this.options = options;
    this.lookupTimeoutMs = Math.max(100, dependencies.lookupTimeoutMs ?? 5_000);
    this.createResolver = dependencies.createResolver ?? (() => new Resolver({ timeout: 2_000, tries: 2 }));
  }

  async resolve(rawUrl: string, signal?: AbortSignal): Promise<ResolvedDestination> {
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
    return this.resolveHost(url.hostname, signal);
  }

  async resolveHost(rawHost: string, signal?: AbortSignal): Promise<ResolvedDestination> {
    if (this.closePromise || this.closingController.signal.aborted) throw this.abortError('Network policy is closing');
    if (signal?.aborted) throw this.abortError('Network resolution was cancelled');
    const hostname = normalizeHost(rawHost);
    if (this.options.blockedHosts.some((pattern) => hostMatches(hostname, pattern))) {
      throw new TendrilError('NETWORK_BLOCKED', `Host is blocked by policy: ${hostname}`);
    }
    const explicitlyAllowed = this.options.allowedHosts.some((pattern) => hostMatches(hostname, pattern));
    const localhost = hostname === 'localhost' || hostname.endsWith('.localhost');
    if (localhost) {
      if (!explicitlyAllowed && this.options.blockPrivateNetworks) {
        throw new TendrilError('NETWORK_BLOCKED', `Private host is blocked: ${hostname}`);
      }
    }

    let addresses: Array<{ address: string; family: 4 | 6 }>;
    if (ipaddr.isValid(hostname)) {
      addresses = [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }];
    } else if (localhost) {
      addresses = [{ address: '127.0.0.1', family: 4 }];
    } else {
      try {
        addresses = await this.lookup(hostname, signal);
      } catch (error) {
        if (error instanceof TendrilError && (error.code === 'CANCELLED' || error.code === 'TIMEOUT')) throw error;
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

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closingController.abort();
    this.closePromise = (async () => {
      do {
        // Yield once so a lookup whose injected resolver synchronously triggered
        // close() can finish registering itself before the closing snapshot.
        await Promise.resolve();
        const active = [...this.activeLookups];
        for (const lookup of active) lookup.cancel();
        await Promise.allSettled(active.map((lookup) => lookup.done));
      } while (this.activeLookups.size > 0);
    })();
    return this.closePromise;
  }

  private abortError(message: string): TendrilError {
    return new TendrilError('CANCELLED', message);
  }

  private async lookup(hostname: string, signal?: AbortSignal): Promise<Array<{ address: string; family: 4 | 6 }>> {
    const resolver = this.createResolver();
    let rejectCancellation!: (error: Error) => void;
    let settled = false;
    let cancellationIssued = false;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = (reason: Error = this.abortError(`DNS lookup cancelled for ${hostname}`)): void => {
      if (settled || cancellationIssued) return;
      cancellationIssued = true;
      rejectCancellation(reason);
      try {
        resolver.cancel();
      } catch {
        /* the rejection above is authoritative */
      }
    };
    const onExternalAbort = (): void => cancel();
    const onPolicyClose = (): void => cancel(this.abortError('Network policy is closing'));

    const resolution = Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]).then((families) => {
      const addresses: Array<{ address: string; family: 4 | 6 }> = [];
      const failures: unknown[] = [];
      for (const [index, family] of families.entries()) {
        if (family.status === 'fulfilled') {
          const addressFamily = index === 0 ? 4 : 6;
          addresses.push(...family.value.map((address) => ({ address, family: addressFamily as 4 | 6 })));
          continue;
        }
        const code = family.reason instanceof Error && 'code' in family.reason ? family.reason.code : undefined;
        if (code !== 'ENODATA' && code !== 'ENOTFOUND') failures.push(family.reason);
      }
      if (addresses.length > 0) return addresses;
      if (failures.length > 0) throw new AggregateError(failures, `DNS resolution failed for ${hostname}`);
      return addresses;
    });
    // Cancellation can win the race even if an injected or platform resolver fails
    // to settle after cancel(); retain a rejection handler on the abandoned work.
    void resolution.catch(() => undefined);
    const done = Promise.race([resolution, cancellation]);
    const active: ActiveLookup = { cancel: () => cancel(), done };
    this.activeLookups.add(active);
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    this.closingController.signal.addEventListener('abort', onPolicyClose, { once: true });
    const timer = setTimeout(() => cancel(new TendrilError('TIMEOUT', `DNS lookup timed out for ${hostname}`, { retryable: true })), this.lookupTimeoutMs);
    // AbortSignal does not replay an abort to listeners registered afterward.
    // Recheck both signals only after this lookup is in the joinable active set.
    if (signal?.aborted) onExternalAbort();
    if (this.closingController.signal.aborted) onPolicyClose();
    try {
      return await done;
    } finally {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
      this.closingController.signal.removeEventListener('abort', onPolicyClose);
      this.activeLookups.delete(active);
    }
  }
}
