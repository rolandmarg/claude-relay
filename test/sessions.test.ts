import { describe, expect, test, beforeEach } from "bun:test";
import { SessionManager } from "../src/sessions";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager({
      cwd: "/tmp/test",
      idleTimeout: 1000, // 1 second for tests
      checkpointInterval: 3,
      notesDir: "relay-notes",
      sessionsFile: "/tmp/test-sessions.json",
    });
  });

  test("registers a new session", () => {
    manager.register("thread-1", "session-abc", "general", "General chat");
    const entry = manager.get("thread-1");
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBe("session-abc");
    expect(entry!.channelName).toBe("general");
    expect(entry!.turnCount).toBe(0);
  });

  test("increments turn count", () => {
    manager.register("thread-1", "session-abc", "general", "General chat");
    manager.incrementTurn("thread-1");
    manager.incrementTurn("thread-1");
    expect(manager.get("thread-1")!.turnCount).toBe(2);
  });

  test("returns true when checkpoint is due", () => {
    manager.register("thread-1", "session-abc", "general", "General chat");
    expect(manager.isCheckpointDue("thread-1")).toBe(false);
    manager.incrementTurn("thread-1");
    manager.incrementTurn("thread-1");
    manager.incrementTurn("thread-1");
    expect(manager.isCheckpointDue("thread-1")).toBe(true);
  });

  test("resets checkpoint counter after checkpoint", () => {
    manager.register("thread-1", "session-abc", "general", "General chat");
    for (let i = 0; i < 3; i++) manager.incrementTurn("thread-1");
    expect(manager.isCheckpointDue("thread-1")).toBe(true);
    manager.resetCheckpoint("thread-1");
    expect(manager.isCheckpointDue("thread-1")).toBe(false);
  });

  test("marks session as inactive on teardown", () => {
    manager.register("thread-1", "session-abc", "general", "General chat");
    manager.markInactive("thread-1");
    const entry = manager.get("thread-1");
    expect(entry!.active).toBe(false);
    // sessionId preserved for resume
    expect(entry!.sessionId).toBe("session-abc");
  });

  test("serializes and restores from JSON", async () => {
    const path = "/tmp/test-relay-sessions.json";
    manager.register("thread-1", "session-abc", "general", "General chat");
    await manager.save(path);

    const restored = await SessionManager.load(path, {
      cwd: "/tmp/test",
      idleTimeout: 1000,
      checkpointInterval: 3,
      notesDir: "relay-notes",
      sessionsFile: path,
    });
    const entry = restored.get("thread-1");
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBe("session-abc");
    // Restored sessions are always inactive (subprocess died on restart)
    expect(entry!.active).toBe(false);
  });
});
