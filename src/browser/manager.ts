import { rm } from 'node:fs/promises';
import { TendrilError } from '../errors.js';
import type { SessionCreateOptions, SessionId, SessionInfo, TendrilConfig } from '../types.js';
import { ensureDir, newId, pathWithinOwnedRoot, type Logger } from '../util.js';
import { acquireProfileFileLock, type ProfileFileLock } from './profile-lock.js';
import { validateProfileName } from './profile-name.js';
import { TendrilSession } from './session.js';

type SessionFactoryOptions = Parameters<typeof TendrilSession.create>[0];
type SessionFactory = (options: SessionFactoryOptions) => Promise<TendrilSession>;

export interface SessionLease {
  readonly session: TendrilSession;
  release(): Promise<void>;
}

interface SessionCreation {
  readonly id: SessionId;
  readonly profile?: string;
  readonly promise: Promise<TendrilSession>;
  leaseGroup?: LeaseGroup;
}

interface LeaseGroup {
  readonly creation: SessionCreation;
  leases: number;
  autoClose: boolean;
}

function resourceCleanupUnverified(error: unknown): boolean {
  return error instanceof TendrilError
    && (error.details?.browserTerminationVerified === false || error.details?.resourceCleanupVerified === false);
}

export class BrowserManager {
  private readonly sessions = new Map<SessionId, TendrilSession>();
  private readonly profileSessions = new Map<string, TendrilSession>();
  private readonly profileReservations = new Map<string, SessionCreation>();
  private readonly leaseGroups = new Map<SessionId, LeaseGroup>();
  private readonly profileFileLocks = new Map<SessionId, ProfileFileLock>();
  private readonly pendingCreates = new Map<SessionId, Promise<TendrilSession>>();
  private readonly pendingCloses = new Map<SessionId, Promise<void>>();
  private readonly cleanupFailures = new Map<SessionId, unknown>();
  private reservedSlots = 0;
  private closingSlots = 0;
  private closing = false;
  private closeAllPromise?: Promise<void>;
  private reapTimer?: NodeJS.Timeout;

  constructor(
    readonly config: TendrilConfig,
    readonly logger: Logger,
    private readonly sessionFactory: SessionFactory = TendrilSession.create,
  ) {}

  async start(): Promise<void> {
    if (this.closing) throw new TendrilError('UNSUPPORTED_OPERATION', 'Browser manager is closing');
    await ensureDir(this.config.dataDir);
    await ensureDir(this.config.runtimeDir);
    if (!this.reapTimer) {
      const intervalMs = Math.max(1_000, Math.min(this.config.sessionIdleMs, 60_000));
      this.reapTimer = setInterval(() => void this.reapIdle(), intervalMs);
      this.reapTimer.unref();
    }
  }

  async create(options: SessionCreateOptions = {}): Promise<TendrilSession> {
    this.assertCanCreate(options);
    if (options.profile) {
      const existing = this.profileSessions.get(options.profile);
      if (existing) {
        this.promoteLeaseGroup(existing.id);
        return existing;
      }
      const pending = this.profileReservations.get(options.profile);
      if (pending) {
        this.promoteLeaseGroup(pending.id);
        return pending.promise;
      }
    }
    return this.beginCreation(options).promise;
  }

  async acquire(options: SessionCreateOptions = {}): Promise<SessionLease> {
    this.assertCanCreate(options);
    if (options.profile) {
      const existing = this.profileSessions.get(options.profile);
      if (existing) {
        const group = this.leaseGroups.get(existing.id);
        return group?.autoClose ? this.joinLeaseGroup(group) : this.borrow(existing);
      }
      const pending = this.profileReservations.get(options.profile);
      if (pending) {
        return pending.leaseGroup?.autoClose
          ? this.joinLeaseGroup(pending.leaseGroup)
          : this.borrow(await pending.promise);
      }
    }

    const creation = this.beginCreation(options);
    const group: LeaseGroup = { creation, leases: 0, autoClose: true };
    creation.leaseGroup = group;
    this.leaseGroups.set(creation.id, group);
    return this.joinLeaseGroup(group);
  }

  private assertCanCreate(options: SessionCreateOptions): void {
    if (this.closing) throw new TendrilError('UNSUPPORTED_OPERATION', 'Browser manager is closing');
    if (options.profile) validateProfileName(options.profile);
  }

  private beginCreation(options: SessionCreateOptions): SessionCreation {
    if (this.sessions.size + this.reservedSlots + this.closingSlots >= this.config.maxSessions) {
      throw new TendrilError('SESSION_LIMIT_REACHED', `Maximum of ${this.config.maxSessions} concurrent sessions reached`, { retryable: true });
    }

    const id = newId('ses');
    const userDataDir = options.profile
      ? pathWithinOwnedRoot(pathWithinOwnedRoot(this.config.dataDir, 'profiles'), options.profile)
      : pathWithinOwnedRoot(pathWithinOwnedRoot(this.config.runtimeDir, 'sessions'), id);
    this.reservedSlots += 1;
    let creation!: SessionCreation;
    let profileLock: ProfileFileLock | undefined;
    const promise = (async (): Promise<TendrilSession> => {
      try {
        if (options.profile) profileLock = await acquireProfileFileLock(this.config.dataDir, options.profile);
        await ensureDir(userDataDir);
        const session = await this.sessionFactory({
          id,
          profile: options.profile,
          userDataDir,
          createOptions: options,
          config: this.config,
          logger: this.logger,
        });
        if (this.closing) {
          try {
            await session.close();
          } catch (error) {
            throw new TendrilError('BROWSER_LAUNCH_FAILED', 'Browser termination could not be verified during manager shutdown', {
              cause: error,
              details: { resourceCleanupVerified: false },
            });
          }
          throw new TendrilError('UNSUPPORTED_OPERATION', 'Browser manager closed while the session was starting');
        }
        this.sessions.set(id, session);
        if (options.profile) {
          this.profileSessions.set(options.profile, session);
          this.profileFileLocks.set(id, profileLock!);
          profileLock = undefined;
        }
        return session;
      } catch (error) {
        const cleanupUnverified = resourceCleanupUnverified(error);
        if (cleanupUnverified) {
          this.closingSlots += 1;
          this.cleanupFailures.set(id, error);
          if (options.profile && profileLock) {
            this.profileFileLocks.set(id, profileLock);
            profileLock = undefined;
            this.logger.error('Retaining profile lock because session resource cleanup was not verified', { sessionId: id, profile: options.profile });
          }
          throw error;
        }

        const cleanupErrors: unknown[] = [];
        if (profileLock) {
          try {
            await profileLock.release();
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
            this.profileFileLocks.set(id, profileLock);
            profileLock = undefined;
          }
        }
        if (!options.profile) {
          // userDataDir is generated from newId beneath the configured runtime root.
          // lgtm[js/path-injection]
          try { await rm(userDataDir, { recursive: true, force: true }); }
          catch (cleanupError) { cleanupErrors.push(cleanupError); }
        }
        if (cleanupErrors.length) {
          const failure = new AggregateError([error, ...cleanupErrors], 'Browser session creation failed and cleanup was incomplete');
          this.closingSlots += 1;
          this.cleanupFailures.set(id, failure);
          throw failure;
        }
        throw error;
      }
    })().finally(() => {
      this.reservedSlots -= 1;
      this.pendingCreates.delete(id);
      if (options.profile && this.profileReservations.get(options.profile) === creation) {
        this.profileReservations.delete(options.profile);
      }
    });
    creation = { id, profile: options.profile, promise };
    this.pendingCreates.set(id, promise);
    if (options.profile) this.profileReservations.set(options.profile, creation);
    return creation;
  }

  private async joinLeaseGroup(group: LeaseGroup): Promise<SessionLease> {
    group.leases += 1;
    let session: TendrilSession;
    try {
      session = await group.creation.promise;
    } catch (error) {
      group.leases -= 1;
      if (group.leases === 0 && this.leaseGroups.get(group.creation.id) === group) {
        this.leaseGroups.delete(group.creation.id);
      }
      throw error;
    }

    let released = false;
    return {
      session,
      release: async () => {
        if (released) return;
        released = true;
        group.leases -= 1;
        if (!group.autoClose || group.leases > 0) return;
        if (this.leaseGroups.get(session.id) === group) this.leaseGroups.delete(session.id);
        await this.close(session.id);
      },
    };
  }

  private borrow(session: TendrilSession): SessionLease {
    return { session, async release() {} };
  }

  private promoteLeaseGroup(id: SessionId): void {
    const group = this.leaseGroups.get(id);
    if (!group) return;
    group.autoClose = false;
    this.leaseGroups.delete(id);
  }

  get(id: string): TendrilSession {
    const session = this.sessions.get(id);
    if (!session) throw new TendrilError('SESSION_NOT_FOUND', `Session not found: ${id}`);
    return session;
  }

  reconnect(profile: string): TendrilSession {
    validateProfileName(profile);
    const session = this.profileSessions.get(profile);
    if (!session) throw new TendrilError('SESSION_NOT_FOUND', `No active session for profile: ${profile}`);
    return session;
  }

  async list(cdpUrlFor?: (session: TendrilSession) => string): Promise<SessionInfo[]> {
    return Promise.all([...this.sessions.values()].map((session) => session.info(cdpUrlFor?.(session))));
  }

  activeCount(): number {
    return this.sessions.size;
  }

  async close(id: string): Promise<void> {
    const pending = this.pendingCloses.get(id);
    if (pending) return pending;
    if (this.cleanupFailures.has(id)) throw this.cleanupFailures.get(id);
    const session = this.sessions.get(id);
    if (!session) return;

    this.closingSlots += 1;
    this.leaseGroups.delete(id);
    this.sessions.delete(id);
    if (session.profile && this.profileSessions.get(session.profile) === session) this.profileSessions.delete(session.profile);
    const closePromise = (async () => {
      const lock = this.profileFileLocks.get(id);
      try {
        await session.close();
        if (lock) {
          await lock.release();
          this.profileFileLocks.delete(id);
        }
        this.cleanupFailures.delete(id);
      } catch (error) {
        this.cleanupFailures.set(id, error);
        if (lock) this.logger.error('Retaining profile lock because session cleanup was not verified', {
          sessionId: id,
          profile: session.profile,
          error: String(error),
        });
        throw error;
      }
    })();
    this.pendingCloses.set(id, closePromise);
    let cleanupVerified = false;
    try {
      await closePromise;
      cleanupVerified = true;
    } finally {
      this.pendingCloses.delete(id);
      if (cleanupVerified) this.closingSlots -= 1;
    }
  }

  async closeAll(): Promise<void> {
    if (this.closeAllPromise) return this.closeAllPromise;
    this.closing = true;
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = undefined;
    }
    this.closeAllPromise = (async () => {
      await Promise.allSettled([...this.pendingCreates.values()]);
      const closes = [...this.pendingCloses.values(), ...[...this.sessions.keys()].map((id) => this.close(id))];
      const results = await Promise.allSettled(closes);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason as unknown);
      for (const failure of this.cleanupFailures.values()) {
        if (!failures.includes(failure)) failures.push(failure);
      }
      if (failures.length) throw new AggregateError(failures, 'One or more browser sessions failed to close completely');
    })();
    return this.closeAllPromise;
  }

  private async reapIdle(): Promise<void> {
    if (this.closing) return;
    const cutoff = Date.now() - this.config.sessionIdleMs;
    const expired = [...this.sessions.values()].filter((session) => (
      session.ephemeral
      && !this.leaseGroups.has(session.id)
      && session.lastActivityAt.getTime() < cutoff
    ));
    for (const session of expired) {
      this.logger.info('Closing idle session', { sessionId: session.id });
      await this.close(session.id).catch((error) => this.logger.warn('Failed to close idle session', { sessionId: session.id, error: String(error) }));
    }
  }
}
