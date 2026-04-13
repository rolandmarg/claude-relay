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
    expect(entry!.status).toBe("active");
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
    expect(entry!.status).toBe("idle");
    expect(entry!.sessionId).toBe("session-abc");
  });

  test("transitions status and syncs active flag", () => {
    manager.register("thread-1", "session-abc", "general", "General chat");
    expect(manager.get("thread-1")!.status).toBe("active");

    manager.setStatus("thread-1", "resolved");
    expect(manager.get("thread-1")!.status).toBe("resolved");
    expect(manager.get("thread-1")!.active).toBe(false);

    manager.setStatus("thread-1", "active");
    expect(manager.get("thread-1")!.status).toBe("active");
    expect(manager.get("thread-1")!.active).toBe(true);

    manager.setStatus("thread-1", "archived");
    expect(manager.get("thread-1")!.status).toBe("archived");
    expect(manager.get("thread-1")!.active).toBe(false);
  });

  test("queries sessions by status", () => {
    manager.register("thread-1", "s1", "general", "");
    manager.register("thread-2", "s2", "models", "");
    manager.register("thread-3", "s3", "harness", "");
    manager.markInactive("thread-2");

    expect(manager.getByStatus("active").length).toBe(2);
    expect(manager.getByStatus("idle").length).toBe(1);
    expect(manager.getByStatus("idle")[0][0]).toBe("thread-2");
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
    expect(entry!.status).toBe("idle");
  });
});
