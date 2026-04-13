import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type ThreadStatus = "active" | "idle" | "resolved" | "archived";

export interface SessionEntry {
  sessionId: string;
  channelName: string;
  channelDescription: string;
  active: boolean;
  status: ThreadStatus;
  turnCount: number;
  turnsSinceCheckpoint: number;
  lastActivity: number;
}

export interface SessionManagerConfig {
  cwd: string;
  idleTimeout: number;
  checkpointInterval: number;
  notesDir: string;
  sessionsFile: string;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private timers = new Map<string, Timer>();
  private onIdle?: (threadId: string, entry: SessionEntry) => void;

  constructor(private config: SessionManagerConfig) {}

  setIdleHandler(handler: (threadId: string, entry: SessionEntry) => void) {
    this.onIdle = handler;
  }

  register(
    threadId: string,
    sessionId: string,
    channelName: string,
    channelDescription: string,
  ) {
    this.sessions.set(threadId, {
      sessionId,
      channelName,
      channelDescription,
      active: true,
      status: "active",
      turnCount: 0,
      turnsSinceCheckpoint: 0,
      lastActivity: Date.now(),
    });
    this.resetIdleTimer(threadId);
    this.save().catch(console.error);
  }

  get(threadId: string): SessionEntry | undefined {
    return this.sessions.get(threadId);
  }

  incrementTurn(threadId: string) {
    const entry = this.sessions.get(threadId);
    if (!entry) return;
    entry.turnCount++;
    entry.turnsSinceCheckpoint++;
    entry.lastActivity = Date.now();
    this.resetIdleTimer(threadId);
  }

  isCheckpointDue(threadId: string): boolean {
    const entry = this.sessions.get(threadId);
    if (!entry) return false;
    return entry.turnsSinceCheckpoint >= this.config.checkpointInterval;
  }

  resetCheckpoint(threadId: string) {
    const entry = this.sessions.get(threadId);
    if (!entry) return;
    entry.turnsSinceCheckpoint = 0;
  }

  markInactive(threadId: string) {
    const entry = this.sessions.get(threadId);
    if (!entry) return;
    entry.active = false;
    entry.status = "idle";
    const timer = this.timers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(threadId);
    }
    this.save().catch(console.error);
  }

  setStatus(threadId: string, status: ThreadStatus) {
    const entry = this.sessions.get(threadId);
    if (!entry) return;
    entry.status = status;
    if (status === "active") entry.active = true;
    if (status === "archived" || status === "resolved") entry.active = false;
    this.save().catch(console.error);
  }

  getByStatus(status: ThreadStatus): [string, SessionEntry][] {
    return [...this.sessions.entries()].filter(([, e]) => e.status === status);
  }

  updateSessionId(threadId: string, sessionId: string) {
    const entry = this.sessions.get(threadId);
    if (!entry) return;
    entry.sessionId = sessionId;
    entry.active = true;
    entry.status = "active";
    entry.lastActivity = Date.now();
    this.resetIdleTimer(threadId);
    this.save().catch(console.error);
  }

  private resetIdleTimer(threadId: string) {
    const existing = this.timers.get(threadId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      threadId,
      setTimeout(() => {
        const entry = this.sessions.get(threadId);
        if (entry && this.onIdle) {
          this.onIdle(threadId, entry);
        }
      }, this.config.idleTimeout),
    );
  }

  async save(path?: string) {
    const file = path ?? this.config.sessionsFile;
    const data: Record<string, SessionEntry> = {};
    for (const [k, v] of this.sessions) {
      data[k] = v;
    }
    await mkdir(dirname(file), { recursive: true }).catch(() => {});
    await writeFile(file, JSON.stringify(data, null, 2));
  }

  static async load(
    path: string,
    config: SessionManagerConfig,
  ): Promise<SessionManager> {
    const manager = new SessionManager(config);
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw) as Record<string, SessionEntry>;
      for (const [threadId, entry] of Object.entries(data)) {
        // All restored sessions are inactive — subprocess died on restart
        entry.active = false;
        if (entry.status === "active") entry.status = "idle";
        manager.sessions.set(threadId, entry);
      }
    } catch {
      // No file yet — start fresh
    }
    return manager;
  }
}
