import path from 'node:path';
import { rm } from 'node:fs/promises';
import { TendrilError } from '../errors.js';
import type { SessionCreateOptions, SessionId, SessionInfo, TendrilConfig } from '../types.js';
import { ensureDir, newId, type Logger } from '../util.js';
import { TendrilSession } from './session.js';

export class BrowserManager {
  private readonly sessions = new Map<SessionId, TendrilSession>();
  private readonly profileLocks = new Map<string, SessionId>();
  private reapTimer?: NodeJS.Timeout;

  constructor(readonly config: TendrilConfig, readonly logger: Logger) {}

  async start(): Promise<void> {
    await ensureDir(this.config.dataDir);
    await ensureDir(this.config.runtimeDir);
    this.reapTimer = setInterval(() => void this.reapIdle(), Math.min(this.config.sessionIdleMs, 60_000));
    this.reapTimer.unref();
  }

  async create(options: SessionCreateOptions = {}): Promise<TendrilSession> {
    if (this.sessions.size >= this.config.maxSessions) {
      throw new TendrilError('SESSION_LIMIT_REACHED', `Maximum of ${this.config.maxSessions} concurrent sessions reached`, { retryable: true });
    }
    if (options.profile && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.profile)) {
      throw new TendrilError('CONFIGURATION_ERROR', 'Profile names must be 1-64 safe filename characters');
    }
    if (options.profile && this.profileLocks.has(options.profile)) {
      throw new TendrilError('PROFILE_IN_USE', `Profile is already active: ${options.profile}`, { retryable: true });
    }
    const id = newId('ses');
    const userDataDir = options.profile
      ? path.join(this.config.dataDir, 'profiles', options.profile)
      : path.join(this.config.runtimeDir, 'sessions', id);
    await ensureDir(userDataDir);
    if (options.profile) this.profileLocks.set(options.profile, id);
    try {
      const session = await TendrilSession.create({
        id, profile: options.profile, userDataDir, createOptions: options,
        config: this.config, logger: this.logger,
      });
      this.sessions.set(id, session);
      return session;
    } catch (error) {
      if (options.profile) this.profileLocks.delete(options.profile);
      if (!options.profile) await rm(userDataDir, { recursive: true, force: true });
      throw error;
    }
  }

  get(id: string): TendrilSession {
    const session = this.sessions.get(id);
    if (!session) throw new TendrilError('SESSION_NOT_FOUND', `Session not found: ${id}`);
    return session;
  }

  async list(cdpUrlFor?: (session: TendrilSession) => string): Promise<SessionInfo[]> {
    return Promise.all([...this.sessions.values()].map((session) => session.info(cdpUrlFor?.(session))));
  }

  async close(id: string): Promise<void> {
    const session = this.get(id);
    this.sessions.delete(id);
    if (session.profile) this.profileLocks.delete(session.profile);
    await session.close();
  }

  async closeAll(): Promise<void> {
    if (this.reapTimer) clearInterval(this.reapTimer);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.profileLocks.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.config.sessionIdleMs;
    const expired = [...this.sessions.values()].filter((session) => session.ephemeral && session.lastActivityAt.getTime() < cutoff);
    for (const session of expired) {
      this.logger.info('Closing idle session', { sessionId: session.id });
      await this.close(session.id).catch((error) => this.logger.warn('Failed to close idle session', { sessionId: session.id, error: String(error) }));
    }
  }
}
