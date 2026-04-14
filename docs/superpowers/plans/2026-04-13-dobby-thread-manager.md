# Dobby Thread Manager — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Dobby — a standalone Haiku-powered Discord bot that auto-titles Relay threads and logs its activity with structured metrics.

**Architecture:** Dobby is a separate Bun process with its own Discord bot token. It watches for new threads created by Relay, waits for the first assistant response, then calls Haiku to generate a 3-7 word title and renames the thread. Relay itself gets a `sanitizeName()` function so initial thread names are clean (no raw mentions). Dobby logs all actions with structured events and tracks metrics (titles generated, failures, latency).

**Tech Stack:** Bun, discord.js, @anthropic-ai/sdk (Haiku), systemd

**Spec:** `docs/superpowers/specs/2026-04-13-dobby-thread-manager-design.md`

---

## File Structure

### Relay-side changes (existing project)

- **Modify:** `src/index.ts` — use `sanitizeName()` for thread names (lines 102, not sweep — sweep is in relay.ts)
- **Modify:** `src/relay.ts` — use `sanitizeName()` for sweep thread names (line 418)
- **Create:** `src/sanitize.ts` — `sanitizeName()` helper

### Dobby (new subdirectory)

```
dobby/
  src/
    index.ts          # Entry: Discord client, event wiring, graceful shutdown
    personality.ts    # System prompt, Dobby message templates
    haiku.ts          # Anthropic client, title generation
    watcher.ts        # Thread event handlers, title orchestration
    log.ts            # Structured logging + metrics counters
  test/
    sanitize.test.ts  # Tests for sanitizeName (shared logic)
    haiku.test.ts     # Tests for title cleaning/parsing
    watcher.test.ts   # Tests for title orchestration logic
  package.json
  tsconfig.json
```

---

### Task 1: Relay-side `sanitizeName()` + tests

**Files:**
- Create: `src/sanitize.ts`
- Create: `test/sanitize.test.ts`
- Modify: `src/index.ts:101-102`
- Modify: `src/relay.ts:417-418`

- [ ] **Step 1: Write the failing tests**

Create `test/sanitize.test.ts`:

```ts
import { test, expect } from "bun:test";
import { sanitizeName } from "../src/sanitize.ts";

test("strips user mentions", () => {
  expect(sanitizeName("<@147214763470461752> hello world")).toBe("hello world");
});

test("strips nickname mentions", () => {
  expect(sanitizeName("<@!147214763470461752> hello")).toBe("hello");
});

test("strips channel mentions", () => {
  expect(sanitizeName("check <#123456789> for details")).toBe("check for details");
});

test("strips role mentions", () => {
  expect(sanitizeName("<@&999999999> announcement")).toBe("announcement");
});

test("strips multiple mentions", () => {
  expect(sanitizeName("<@111> hey <@222> what's up")).toBe("hey what's up");
});

test("collapses multiple spaces", () => {
  expect(sanitizeName("hello    world")).toBe("hello world");
});

test("trims whitespace", () => {
  expect(sanitizeName("  hello world  ")).toBe("hello world");
});

test("truncates at 80 chars with ellipsis", () => {
  const long = "a".repeat(100);
  const result = sanitizeName(long);
  expect(result.length).toBe(80);
  expect(result.endsWith("...")).toBe(true);
  expect(result).toBe("a".repeat(77) + "...");
});

test("does not truncate at exactly 80 chars", () => {
  const exact = "a".repeat(80);
  expect(sanitizeName(exact)).toBe(exact);
});

test("returns fallback for empty content", () => {
  const result = sanitizeName("");
  expect(result).toMatch(/^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("returns fallback when content is only mentions", () => {
  const result = sanitizeName("<@147214763470461752>");
  expect(result).toMatch(/^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("strips custom emoji syntax", () => {
  expect(sanitizeName("hello <:smile:123456> world")).toBe("hello world");
});

test("strips animated emoji syntax", () => {
  expect(sanitizeName("hello <a:dance:789> world")).toBe("hello world");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /var/home/kira/claude-relay && bun test test/sanitize.test.ts`
Expected: FAIL — module `../src/sanitize.ts` not found

- [ ] **Step 3: Implement `sanitizeName()`**

Create `src/sanitize.ts`:

```ts
/**
 * Sanitize Discord message content into a clean thread name.
 *
 * Strips mentions (<@id>, <@!id>, <#id>, <@&id>), custom emoji (<:name:id>, <a:name:id>),
 * collapses whitespace, truncates to 80 chars with "...", falls back to timestamp.
 */
export function sanitizeName(content: string): string {
  let name = content
    .replace(/<@!?\d+>/g, "")        // user/nickname mentions
    .replace(/<#\d+>/g, "")          // channel mentions
    .replace(/<@&\d+>/g, "")         // role mentions
    .replace(/<a?:\w+:\d+>/g, "")    // custom/animated emoji
    .replace(/\s+/g, " ")            // collapse whitespace
    .trim();

  if (!name) {
    return `Session ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  }

  if (name.length > 80) {
    name = name.slice(0, 77) + "...";
  }

  return name;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /var/home/kira/claude-relay && bun test test/sanitize.test.ts`
Expected: All 13 tests PASS

- [ ] **Step 5: Wire `sanitizeName()` into Relay**

Edit `src/index.ts` — add import at top (after line 4):

```ts
import { sanitizeName } from "./sanitize.js";
```

Replace line 102:
```ts
          name: message.content.slice(0, 90) || `Session ${new Date().toISOString().slice(0, 16)}`,
```
with:
```ts
          name: sanitizeName(message.content),
```

Edit `src/relay.ts` — add import at top (after line 6):

```ts
import { sanitizeName } from "./sanitize.js";
```

Replace line 418:
```ts
              name: msg.content.slice(0, 90) || `Session ${new Date().toISOString().slice(0, 16)}`,
```
with:
```ts
              name: sanitizeName(msg.content),
```

- [ ] **Step 6: Run full test suite + typecheck**

Run: `cd /var/home/kira/claude-relay && bun test && bunx tsc --noEmit`
Expected: All tests pass, no type errors

- [ ] **Step 7: Commit**

```bash
cd /var/home/kira/claude-relay
git add src/sanitize.ts test/sanitize.test.ts src/index.ts src/relay.ts
git commit -m "feat: sanitize thread names — strip mentions, truncate to 80 chars"
```

---

### Task 2: Dobby project scaffold

**Files:**
- Create: `dobby/package.json`
- Create: `dobby/tsconfig.json`
- Create: `dobby/src/log.ts`
- Create: `dobby/src/personality.ts`

- [ ] **Step 1: Create `dobby/package.json`**

```json
{
  "name": "dobby",
  "version": "0.0.1",
  "description": "Thread lifecycle elf — auto-titles, tidies, and watches over Relay threads",
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch run src/index.ts",
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.81.0",
    "discord.js": "^14.18.0"
  }
}
```

Note: Dobby uses `@anthropic-ai/sdk` directly (not the agent SDK) since it only needs simple Haiku completions.

- [ ] **Step 2: Create `dobby/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["bun-types"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `dobby/src/log.ts`**

Structured logging with metrics counters. Same format as Relay (`ISO | EVENT | ID | DETAIL`) so logs are greppable together.

```ts
/** Dobby log events */
export type LogEvent =
  | "DOBBY_BOOT"
  | "DOBBY_SHUTDOWN"
  | "DOBBY_METRICS"
  | "THREAD_DETECTED"
  | "TITLE_GENERATED"
  | "TITLE_RENAMED"
  | "TITLE_FAILED"
  | "HAIKU_CALL"
  | "HAIKU_ERROR"
  | "DISCORD_ERROR";

/** Simple in-memory metrics counters */
const counters: Record<string, number> = {
  threads_detected: 0,
  titles_generated: 0,
  titles_applied: 0,
  titles_failed: 0,
  haiku_calls: 0,
  haiku_errors: 0,
  haiku_latency_total_ms: 0,
};

export function log(event: LogEvent, threadId: string, detail?: string) {
  const ts = new Date().toISOString();
  const parts = [ts, event, threadId];
  if (detail) parts.push(detail);
  console.log(parts.join(" | "));
}

export function increment(metric: keyof typeof counters, value = 1) {
  counters[metric] = (counters[metric] ?? 0) + value;
}

export function getMetrics(): Readonly<typeof counters> {
  return { ...counters };
}

/** Log a metrics summary — call periodically or on shutdown */
export function logMetrics() {
  const m = getMetrics();
  const avgLatency = m.haiku_calls > 0
    ? Math.round(m.haiku_latency_total_ms / m.haiku_calls)
    : 0;
  log("DOBBY_METRICS", "*", [
    `threads=${m.threads_detected}`,
    `titled=${m.titles_applied}`,
    `failed=${m.titles_failed}`,
    `haiku_calls=${m.haiku_calls}`,
    `haiku_errors=${m.haiku_errors}`,
    `avg_latency=${avgLatency}ms`,
  ].join(" "));
}
```

- [ ] **Step 4: Create `dobby/src/personality.ts`**

```ts
/** Dobby's system prompt for Haiku calls */
export const SYSTEM_PROMPT = `You are Dobby, a devoted house-elf who tends to Discord threads. You speak in third person ("Dobby has...", "Dobby notices..."). You are earnest, loyal, and take great pride in keeping threads tidy and well-named. You are slightly dramatic but never annoying. You serve the guild with quiet diligence.

Your current task: generate short, descriptive thread titles (3-7 words). Return ONLY the title text — no quotes, no punctuation at the end, no prefixes like "Title:".`;

/** Prompt template for title generation */
export function titlePrompt(userMessage: string): string {
  const snippet = userMessage.slice(0, 500);
  return `Generate a short, descriptive title (3-7 words) for a conversation that starts with this message:\n\n${snippet}`;
}
```

- [ ] **Step 5: Install dependencies**

Run: `cd /var/home/kira/claude-relay/dobby && bun install`
Expected: lockfile created, packages installed

- [ ] **Step 6: Commit**

```bash
cd /var/home/kira/claude-relay
git add dobby/package.json dobby/tsconfig.json dobby/bun.lock dobby/src/log.ts dobby/src/personality.ts
git commit -m "feat(dobby): project scaffold with logging, metrics, and personality"
```

---

### Task 3: Haiku title generation + tests

**Files:**
- Create: `dobby/src/haiku.ts`
- Create: `dobby/test/haiku.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `dobby/test/haiku.test.ts`:

```ts
import { test, expect } from "bun:test";
import { cleanTitle } from "../src/haiku.ts";

test("returns title as-is when clean", () => {
  expect(cleanTitle("Model and Reasoning Query")).toBe("Model and Reasoning Query");
});

test("strips surrounding double quotes", () => {
  expect(cleanTitle('"Model Query"')).toBe("Model Query");
});

test("strips surrounding single quotes", () => {
  expect(cleanTitle("'Model Query'")).toBe("Model Query");
});

test("strips Title: prefix", () => {
  expect(cleanTitle("Title: Model Query")).toBe("Model Query");
});

test("strips title: prefix case-insensitive", () => {
  expect(cleanTitle("title: Model Query")).toBe("Model Query");
});

test("strips trailing period", () => {
  expect(cleanTitle("Model Query.")).toBe("Model Query");
});

test("truncates to 80 chars with ellipsis", () => {
  const long = "word ".repeat(20); // 100 chars
  const result = cleanTitle(long);
  expect(result.length).toBe(80);
  expect(result.endsWith("...")).toBe(true);
});

test("does not truncate at exactly 80 chars", () => {
  const exact = "a".repeat(80);
  expect(cleanTitle(exact)).toBe(exact);
});

test("returns null for empty string", () => {
  expect(cleanTitle("")).toBeNull();
});

test("returns null for whitespace-only", () => {
  expect(cleanTitle("   ")).toBeNull();
});

test("handles combined cleanup", () => {
  expect(cleanTitle('"Title: Some Good Title."')).toBe("Some Good Title");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /var/home/kira/claude-relay/dobby && bun test test/haiku.test.ts`
Expected: FAIL — `cleanTitle` not found

- [ ] **Step 3: Implement `haiku.ts`**

Create `dobby/src/haiku.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, titlePrompt } from "./personality.ts";
import { log, increment } from "./log.ts";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;

export function initHaiku(apiKey: string) {
  client = new Anthropic({ apiKey });
}

/**
 * Clean up a raw title from Haiku: strip quotes, prefixes, trailing punctuation,
 * enforce 80 char max. Returns null if result is empty.
 */
export function cleanTitle(raw: string): string | null {
  let title = raw.trim();
  // Strip surrounding quotes
  if ((title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))) {
    title = title.slice(1, -1);
  }
  // Strip "Title:" prefix
  if (title.toLowerCase().startsWith("title:")) {
    title = title.slice(6);
  }
  // Strip trailing period
  title = title.replace(/\.$/, "");
  title = title.trim();

  if (!title) return null;

  if (title.length > 80) {
    title = title.slice(0, 77) + "...";
  }
  return title;
}

/**
 * Call Haiku to generate a thread title from a user message.
 * Returns the cleaned title or null on failure.
 */
export async function generateTitle(userMessage: string): Promise<string | null> {
  if (!client) {
    log("HAIKU_ERROR", "*", "Haiku client not initialized");
    return null;
  }

  const start = Date.now();
  increment("haiku_calls");

  try {
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 30,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: titlePrompt(userMessage) }],
    });

    const latency = Date.now() - start;
    increment("haiku_latency_total_ms", latency);

    const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
    const title = cleanTitle(raw);

    if (title) {
      increment("titles_generated");
      log("TITLE_GENERATED", "*", `"${title}" (${latency}ms)`);
    }

    return title;
  } catch (err) {
    increment("haiku_errors");
    const msg = err instanceof Error ? err.message : String(err);
    log("HAIKU_ERROR", "*", msg);
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /var/home/kira/claude-relay/dobby && bun test test/haiku.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /var/home/kira/claude-relay
git add dobby/src/haiku.ts dobby/test/haiku.test.ts
git commit -m "feat(dobby): Haiku title generation with cleanTitle + tests"
```

---

### Task 4: Thread watcher + tests

**Files:**
- Create: `dobby/src/watcher.ts`
- Create: `dobby/test/watcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `dobby/test/watcher.test.ts`:

```ts
import { test, expect } from "bun:test";
import { shouldWatchThread, extractFirstUserMessage } from "../src/watcher.ts";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /var/home/kira/claude-relay/dobby && bun test test/watcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `watcher.ts`**

Create `dobby/src/watcher.ts`:

```ts
import type { ThreadChannel, Message, Collection } from "discord.js";
import { generateTitle } from "./haiku.ts";
import { log, increment } from "./log.ts";

/** Set of thread IDs already titled — prevents duplicate work */
const titledThreads = new Set<string>();

/**
 * Should Dobby watch this thread? True if the thread's owner is the Relay bot.
 */
export function shouldWatchThread(
  threadOwnerId: string,
  relayBotId: string,
  selfId?: string,
): boolean {
  if (selfId && threadOwnerId === selfId) return false;
  return threadOwnerId === relayBotId;
}

/**
 * Extract the first user (non-bot, non-self) message from a list of messages.
 */
export function extractFirstUserMessage(
  messages: Array<{ author: { bot: boolean; id: string }; content: string }>,
  relayBotId: string,
  selfId?: string,
): string | null {
  for (const msg of messages) {
    if (msg.author.bot) continue;
    if (selfId && msg.author.id === selfId) continue;
    return msg.content || null;
  }
  return null;
}

/**
 * Attempt to auto-title a Relay thread. Called when Dobby detects
 * the Relay bot has posted its first response in a thread.
 *
 * Fire-and-forget: errors are logged, never thrown.
 */
export async function autoTitle(
  thread: ThreadChannel,
  userMessage: string,
): Promise<void> {
  const threadId = thread.id;

  if (titledThreads.has(threadId)) return;
  titledThreads.add(threadId);

  increment("threads_detected");
  log("THREAD_DETECTED", threadId, `"${userMessage.slice(0, 60)}"`);

  const title = await generateTitle(userMessage);
  if (!title) {
    increment("titles_failed");
    log("TITLE_FAILED", threadId, "Haiku returned no title");
    return;
  }

  try {
    await thread.setName(title);
    increment("titles_applied");
    log("TITLE_RENAMED", threadId, `"${title}"`);
  } catch (err) {
    increment("titles_failed");
    const msg = err instanceof Error ? err.message : String(err);
    log("DISCORD_ERROR", threadId, `setName failed: ${msg}`);
  }
}

/**
 * Handle a new message in any channel/thread. Determines if this is
 * the first Relay response in a Relay-owned thread and triggers titling.
 */
export async function onMessage(
  message: Message,
  relayBotId: string,
  selfId: string,
): Promise<void> {
  // Only care about messages from Relay bot
  if (message.author.id !== relayBotId) return;

  // Must be in a thread
  const thread = message.channel;
  if (!thread.isThread()) return;

  const threadId = thread.id;

  // Already titled
  if (titledThreads.has(threadId)) return;

  // Must be a Relay-owned thread
  if (!shouldWatchThread(thread.ownerId ?? "", relayBotId, selfId)) return;

  // Fetch the thread's messages to find the first user message
  try {
    const fetched = await thread.messages.fetch({ limit: 10 });
    // Discord returns newest first — reverse to chronological
    const messages = [...fetched.values()].reverse();
    const userMsg = extractFirstUserMessage(
      messages.map(m => ({ author: { bot: m.author.bot, id: m.author.id }, content: m.content })),
      relayBotId,
      selfId,
    );

    if (userMsg) {
      await autoTitle(thread, userMsg);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("DISCORD_ERROR", threadId, `fetch messages failed: ${msg}`);
  }
}

/** Clear the titled set — useful for testing or long-running resets */
export function clearTitledCache() {
  titledThreads.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /var/home/kira/claude-relay/dobby && bun test test/watcher.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /var/home/kira/claude-relay
git add dobby/src/watcher.ts dobby/test/watcher.test.ts
git commit -m "feat(dobby): thread watcher — detects Relay threads, triggers auto-title"
```

---

### Task 5: Dobby entry point + boot

**Files:**
- Create: `dobby/src/index.ts`

- [ ] **Step 1: Create `dobby/src/index.ts`**

```ts
import { Client, GatewayIntentBits } from "discord.js";
import { initHaiku } from "./haiku.ts";
import { onMessage } from "./watcher.ts";
import { log, logMetrics } from "./log.ts";

// --- Config from env ---

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RELAY_BOT_ID = process.env.RELAY_BOT_ID;

if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is required");
if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
if (!RELAY_BOT_ID) throw new Error("RELAY_BOT_ID is required");

// --- Init ---

initHaiku(ANTHROPIC_API_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Event handlers ---

client.on("messageCreate", async (message) => {
  try {
    await onMessage(message, RELAY_BOT_ID, client.user?.id ?? "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("DISCORD_ERROR", message.channel.id, `onMessage error: ${msg}`);
  }
});

// --- Metrics reporting (every 5 minutes) ---

const metricsTimer = setInterval(() => logMetrics(), 5 * 60_000);

// --- Graceful shutdown ---

async function shutdown() {
  log("DOBBY_SHUTDOWN", "*", "Dobby is going to sleep...");
  logMetrics();
  clearInterval(metricsTimer);
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Boot ---

await client.login(DISCORD_TOKEN);
log("DOBBY_BOOT", "*", `Dobby is free! Watching for Relay (${RELAY_BOT_ID}) threads as ${client.user?.tag}`);
```

- [ ] **Step 2: Typecheck**

Run: `cd /var/home/kira/claude-relay/dobby && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all Dobby tests**

Run: `cd /var/home/kira/claude-relay/dobby && bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd /var/home/kira/claude-relay
git add dobby/src/index.ts
git commit -m "feat(dobby): entry point with Discord client, metrics timer, graceful shutdown"
```

---

### Task 6: Systemd unit + deployment

**Files:**
- Create: `dobby/dobby.service`

- [ ] **Step 1: Create systemd unit file**

Create `dobby/dobby.service`:

```ini
[Unit]
Description=Dobby — Thread lifecycle elf for Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/kira/.bun/bin/bun run src/index.ts
WorkingDirectory=/var/home/kira/claude-relay/dobby
EnvironmentFile=/var/home/kira/claude-relay/dobby/.env
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dobby

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Create `.env` file (not committed)**

Create `dobby/.env` (manually, not committed — add to `.gitignore`):

```env
DISCORD_TOKEN=<dobby's bot token>
ANTHROPIC_API_KEY=<api key>
RELAY_BOT_ID=<relay's discord user id>
```

- [ ] **Step 3: Add `.env` to gitignore**

Append to `dobby/.gitignore` (create if needed):

```
.env
node_modules/
dist/
```

- [ ] **Step 4: Install and enable the service**

```bash
# Symlink the unit file for user service
mkdir -p ~/.config/systemd/user
ln -s /var/home/kira/claude-relay/dobby/dobby.service ~/.config/systemd/user/dobby.service
systemctl --user daemon-reload
systemctl --user enable dobby
systemctl --user start dobby
```

- [ ] **Step 5: Verify Dobby is running**

```bash
systemctl --user status dobby
journalctl --user -u dobby -n 20 --no-pager
```

Expected: Active (running), log shows `DOBBY_BOOT | * | Dobby is free! Watching for Relay (...) threads as Dobby#...`

- [ ] **Step 6: Commit service file and gitignore**

```bash
cd /var/home/kira/claude-relay
git add dobby/dobby.service dobby/.gitignore
git commit -m "feat(dobby): systemd service unit for deployment"
```

---

### Task 7: End-to-end verification

**Files:** None (observational)

- [ ] **Step 1: Create a Discord bot application for Dobby**

Go to Discord Developer Portal, create a new application called "Dobby". Set the avatar to a house-elf image. Create a bot user. Copy the token to `dobby/.env`. Enable the Message Content intent. Generate an invite link with bot permissions (Read Messages, Send Messages, Manage Threads) and invite to the guild.

- [ ] **Step 2: Get Relay's bot user ID**

In Discord, right-click Relay's bot user → Copy User ID. Set this as `RELAY_BOT_ID` in `dobby/.env`.

- [ ] **Step 3: Start Dobby and Relay**

```bash
systemctl --user restart dobby
# Relay should already be running, or:
cd /var/home/kira/claude-relay && bun run start
```

- [ ] **Step 4: Send a test message to a Relay channel**

In Discord, send a message mentioning Relay in a channel:
```
@Relay hey what model are you on? and what effort/reasoning model
```

- [ ] **Step 5: Observe thread naming**

Watch the thread:
1. Thread is created with sanitized name: `hey what model are you on? and what effort/reasoning model` (no `<@id>`)
2. Relay responds in the thread
3. Within a few seconds, thread name changes to something like `Model and Reasoning Effort Query`

- [ ] **Step 6: Check Dobby's logs**

```bash
journalctl --user -u dobby -n 50 --no-pager
```

Expected log sequence:
```
... | THREAD_DETECTED | <threadId> | "hey what model are you on?..."
... | HAIKU_CALL | * | ...
... | TITLE_GENERATED | * | "Model and Reasoning Effort Query" (350ms)
... | TITLE_RENAMED | <threadId> | "Model and Reasoning Effort Query"
```

- [ ] **Step 7: Test failure case — Dobby handles errors gracefully**

Temporarily set an invalid `ANTHROPIC_API_KEY` in `.env`, restart Dobby, send a message. Verify:
- Thread keeps its sanitized name (no crash)
- Dobby logs `HAIKU_ERROR` and `TITLE_FAILED`
- Restore the correct key and restart

- [ ] **Step 8: Check metrics after 5 minutes**

```bash
journalctl --user -u dobby --since "5 minutes ago" --no-pager | grep DOBBY_BOOT
```

Expected: metrics summary with `threads=1 titled=1 failed=0 haiku_calls=1 ...`
