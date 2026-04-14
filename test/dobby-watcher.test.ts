import { expect, test } from "bun:test";
import { extractFirstUserMessage, shouldWatchThread } from "../src/dobby/watcher";

const RELAY_BOT_ID = "999888777";

test("shouldWatchThread returns true for thread created by relay bot", () => {
  expect(shouldWatchThread(RELAY_BOT_ID, RELAY_BOT_ID)).toBe(true);
});

test("shouldWatchThread returns false for thread created by other user", () => {
  expect(shouldWatchThread("111222333", RELAY_BOT_ID)).toBe(false);
});

test("shouldWatchThread returns false for thread created by self", () => {
  expect(shouldWatchThread("444555666", RELAY_BOT_ID, "444555666")).toBe(false);
});

test("extractFirstUserMessage returns first non-bot message content", () => {
  const messages = [
    { author: { bot: true, id: RELAY_BOT_ID }, content: "bot message" },
    { author: { bot: false, id: "user123" }, content: "hey what model are you on?" },
    { author: { bot: true, id: RELAY_BOT_ID }, content: "I am on Opus" },
  ];
  expect(extractFirstUserMessage(messages, RELAY_BOT_ID)).toBe("hey what model are you on?");
});

test("extractFirstUserMessage returns null if no user messages", () => {
  const messages = [
    { author: { bot: true, id: RELAY_BOT_ID }, content: "bot message" },
  ];
  expect(extractFirstUserMessage(messages, RELAY_BOT_ID)).toBeNull();
});

test("extractFirstUserMessage skips Dobby's own messages", () => {
  const dobbyId = "444555666";
  const messages = [
    { author: { bot: false, id: dobbyId }, content: "Dobby has renamed" },
    { author: { bot: false, id: "user123" }, content: "real user message" },
  ];
  expect(extractFirstUserMessage(messages, RELAY_BOT_ID, dobbyId)).toBe("real user message");
});
