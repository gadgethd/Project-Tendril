import { describe, expect, it } from 'vitest';
import { isPrivateAddress, NetworkPolicy } from '../src/security/network-policy.js';

describe('NetworkPolicy', () => {
  it('classifies non-public addresses', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.2.3.4')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('blocks localhost unless explicitly allowed', async () => {
    const blocked = new NetworkPolicy({ blockPrivateNetworks: true, allowedHosts: [], blockedHosts: [] });
    await expect(blocked.resolve('http://127.0.0.1/')).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
    const allowed = new NetworkPolicy({ blockPrivateNetworks: true, allowedHosts: ['localhost', '127.0.0.1'], blockedHosts: [] });
    await expect(allowed.resolve('http://127.0.0.1/')).resolves.toMatchObject({ address: '127.0.0.1', explicitlyAllowed: true });
  });

  it('applies blocklists before allowlists', async () => {
    const policy = new NetworkPolicy({ blockPrivateNetworks: false, allowedHosts: ['*.example.com'], blockedHosts: ['admin.example.com'] });
    await expect(policy.resolveHost('admin.example.com')).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
  });
});
