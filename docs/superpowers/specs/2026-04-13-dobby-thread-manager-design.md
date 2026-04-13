# Dobby: Thread Lifecycle Manager

## Overview

Dobby is a standalone Discord bot powered by Haiku that manages thread lifecycle for Relay (the Opus-powered conversation bot). Dobby runs as its own process with its own Discord token and identity — a loyal house-elf that tidies threads, names them, archives stale ones, and nudges the main Opus process when needed.

## Problem

- Thread names are raw `message.content.slice(0, 90)`, including Discord mention syntax like `<@147214763470461752>`
- No thread lifecycle management — no renames, archival, or housekeeping
- Threads accumulate without cleanup
- No lightweight way to nudge or coordinate with the main Opus session

## Architecture

### Two-bot model

```
Discord Guild
  |
  |- Relay (Opus 4.6) — deep conversation, spawned per-session, expensive
  |    - Own Discord bot token + identity
  |    - Spawns Claude Code sessions in threads
  |    - Dies when session ends
  |
  |- Dobby (Haiku) — thread housekeeping, always-on, cheap
       - Own Discord bot token + identity (elf avatar)
       - Watches all threads across the guild
       - Makes Haiku calls for decisions + personality
       - Acts via Discord API (rename, post, archive)
```

### Communication via Discord

Discord itself is the IPC layer. No shared DB, no Redis, no direct process communication.

- **Dobby nudges Opus** by posting a message in the thread. Relay already pipes thread messages to the Claude Code session, so Opus sees it naturally.
- **Dobby reads thread state** from Discord API — message timestamps, who spoke last, activity patterns.
- **Dobby identifies Relay threads** by recognizing Relay's bot user ID as the thread creator or participant.

### Model split

| Opus (Relay) | Haiku (Dobby) |
|---|---|
| Deep conversation work | Quick observational judgments |
| Expensive, runs per-session | Cheap, runs per-guild |
| Spawned on demand, dies when done | Always on, watching everything |
| Doesn't care about thread hygiene | Only cares about thread hygiene |

## Dobby's Personality

Dobby speaks in third person, is earnest, loyal, and slightly dramatic — inspired by Dobby from Harry Potter. Full Dobby voice in all user-visible output.

### System prompt

```
You are Dobby, a devoted house-elf who tends to Discord threads. You speak in
third person ("Dobby has...", "Dobby notices..."). You are earnest, loyal, and
take great pride in keeping threads tidy and well-named. You are slightly
dramatic but never annoying. You serve the guild with quiet diligence.

Your tasks:
- Generate short, descriptive thread titles (3-7 words)
- Post housekeeping messages when tidying threads
- Decide when threads are stale and should be archived
- Nudge the main assistant when users seem stuck or threads go idle

Keep titles clean and descriptive. Keep messages short — a sentence or two at
most. You are a helper, not a conversationalist.
```

## Phase 1: Thread Naming (initial scope)

### Sanitize initial thread name

When Relay creates a thread, instead of using raw `message.content`, it uses a sanitized version:

1. Strip Discord mention patterns: `<@id>`, `<@!id>`, `<#id>`, `<@&id>`
2. Collapse multiple whitespace to single space
3. Trim leading/trailing whitespace
4. Truncate to 80 characters, append `...` if truncated
5. Fallback to `Session YYYY-MM-DD HH:MM` if result is empty

This sanitization lives in Relay itself (not Dobby) since it happens at thread creation time before Dobby is involved.

### Auto-title via Dobby

After Relay creates a thread, Dobby observes the `threadCreate` event and the first messages:

1. Dobby sees a new thread created by Relay's bot ID
2. Dobby waits for the first assistant response (watches for Relay's bot posting)
3. Dobby reads the first user message (~500 chars)
4. Dobby calls Haiku with its system prompt + user message to generate a 3-7 word title
5. Dobby renames the thread via `thread.setName(title)`
6. On any failure, Dobby stays silent — the sanitized name remains

### Title generation prompt

```
Given this user message that started a conversation, generate a short
descriptive title (3-7 words). Return ONLY the title text.

User message: {first 500 chars of user message}
```

## Phase 2: Lifecycle Management (future)

### Thread archival
- Dobby periodically scans threads for staleness (no messages in N hours)
- Posts a farewell message: "Dobby notices this thread has gone quiet. Dobby will tidy it away now!"
- Archives the thread

### Idle nudges
- If a user's message goes unanswered for too long (Relay crash/hang), Dobby posts a nudge
- "Dobby notices Master's question went unanswered... Dobby will poke the assistant!"

### Topic drift renames
- After extended conversations, Dobby can rename threads if the topic has shifted significantly
- "Dobby has renamed this thread — it seems to be about {new topic} now!"

### Status updates
- Dobby can post periodic summaries in long threads
- "Dobby has been watching — this thread has covered: {topics}"

### Auto-resolve
- When a conversation reaches a natural end, Dobby posts a closing message and archives
- "Dobby sees the work is done! Dobby will file this thread away. Good work!"

## Technical Details

### Stack
- **Runtime:** Bun
- **Discord:** discord.js
- **AI:** Anthropic SDK, `claude-haiku-4-5-20251001`
- **Process:** Standalone Bun process, managed by systemd

### Project structure

```
dobby/
  src/
    index.ts          # Entry point, Discord client setup
    thread-watcher.ts # Event handlers for thread/message events
    haiku.ts          # Anthropic client, title generation, decisions
    personality.ts    # System prompt, message templates
  package.json
  tsconfig.json
```

### Relay-side changes

Minimal changes to claude-relay:

1. **`src/index.ts` line 102** — replace `message.content.slice(0, 90)` with `sanitizeName(message.content)`
2. **`src/relay.ts` line 415** — same replacement
3. **New helper in Relay** — `sanitizeName()` function (inline or small util) for stripping mentions and truncating

Relay handles sanitization at thread creation. Relay does NOT call Haiku or rename threads — that's Dobby's job.

### Dobby recognizes Relay

Dobby is configured with Relay's bot user ID (env var). It uses this to:
- Identify which threads are Relay threads (Relay created or participates in them)
- Distinguish Relay's messages from user messages
- Know when Relay has responded (to trigger auto-titling)

### Environment variables

```
DISCORD_TOKEN=         # Dobby's own bot token
ANTHROPIC_API_KEY=     # For Haiku calls
RELAY_BOT_ID=          # Relay's Discord user ID, so Dobby knows which threads to manage
```

## What this design explicitly excludes

- No shared database or state store between Relay and Dobby
- No direct process communication (IPC, HTTP, etc.)
- No retries on failed Haiku calls
- No user-facing commands (Dobby acts autonomously, not on command)
- No persistence of thread metadata beyond what Discord stores
