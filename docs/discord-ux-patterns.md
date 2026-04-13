# Discord UX Patterns — Reference for claude-relay

Patterns borrowed from Claude Code's Discord plugin and Hermes Agent that we should adopt.

## From Claude Code Discord Plugin

### Pairing & Access Control
- **Explicit channel opt-in.** Bot ignores all channels by default. Channels must be paired via a terminal command — never via a Discord message (that's prompt injection).
- **6-char pairing code.** Unknown sender DMs → bot generates code → user runs `/discord:access pair <code>` in terminal → channel is approved. Temp file handoff between server and skill.
- **Per-channel config** with granular controls: mention requirements, user allowlists, delivery settings.
- **Gate on every message.** Re-read access.json on each inbound message. No stale cached state.
- **Outbound permission gate.** Tools can only reply to channels that passed inbound auth.
- **Separate credential storage** from access config (.env chmod 0o600 vs access.json).

### Delivery Config
- `ackReaction` — configurable emoji on message receipt.
- `replyToMode` — off | first | all (threading behavior for chunked responses).
- `textChunkLimit` — split threshold (max 2000).
- `chunkMode` — length | newline (split strategy).

### Security Rules
- Never trust channel messages to approve pairings.
- Skills for access management run in terminal only.
- Sender ID ≠ Chat ID — track both.

---

## From Hermes Agent

### Ack Emoji Flow (this is what makes it feel "comfy")
1. Message received → immediately add **👀** (eyes) emoji.
2. While processing → typing indicator loop (refresh every 8s).
3. Done → remove 👀, add **✅** (success) or **❌** (error).

This gives instant visual feedback that the bot heard you, and a clear signal when it's done. No "did it crash?" anxiety.

### Threading
- Auto-create threads from channel messages (first 80 chars as thread name).
- Threads auto-archive after 24 hours.
- Existing threads and DMs bypass auto-threading.
- Configurable per-channel: some channels can disable auto-threading.

### Long Response Handling
- Split at 1,900 chars (buffer under Discord's 2,000 limit).
- Only the first chunk includes a reply-reference to the original message.
- Keeps threads clean — subsequent chunks are plain messages.

### Working State
- Persistent typing indicator loop while processing.
- Tool progress updates: show what tools are running (configurable verbosity).
- Combined with 👀 emoji, the user always knows the bot is alive and working.

### Multi-User Isolation
- Per-user session isolation by default in shared channels.
- Alice and Bob in the same channel get separate conversation histories.
- Prevents context bleeding and token waste.

### Error Recovery
- If reply-to a Discord system message fails, silently retry without the reference.
- Prevents failed sends from breaking the flow.

---

## What claude-relay should adopt

### Priority 1 — Must have
- [ ] **Ack emoji flow** (👀 → ✅/❌) — replaces the current 🔄 reaction
- [ ] **Typing indicator** while session is processing
- [ ] **Reply-to on first chunk only** — cleaner threading
- [ ] **1900-char split limit** — buffer under Discord max

### Priority 2 — Should have
- [ ] **Channel pairing** — explicit opt-in via terminal command
- [ ] **Access.json gating** — re-read on every message
- [ ] **Per-user session isolation** in shared channels (future, when multi-user)

### Priority 3 — Nice to have
- [ ] **Tool progress messages** — show what Claude Code is doing
- [ ] **Configurable delivery settings** (ackReaction, replyToMode, chunkMode)
- [ ] **Thread auto-archive duration** as config
- [ ] **Progressive message editing** — stream Claude Code response into a message, editing in real-time
- [ ] **Skills as slash commands** — auto-register Claude Code skills as Discord slash commands with autocomplete
- [ ] **Webhook mode** — run as webhook endpoint instead of gateway (better for hosted deploys)

---

## Additional Hermes Agent Patterns (Deep Dive)

### Progressive Message Editing (Streaming UX)
Instead of waiting for the full response and dumping it all at once, Hermes edits its reply message progressively as the LLM streams. Users see the answer building in real-time. Critical for long-running Claude Code sessions (30+ seconds) — without this, the user stares at a typing indicator wondering if something broke. Implementation: send an initial "thinking..." message, then `message.edit()` as chunks arrive, finally replace with the complete response.

### Skills → Slash Commands
Every installed skill auto-registers as a native Discord slash command with autocomplete (up to 75, Discord's limit). Users type `/` and see available skills. For claude-relay this could mean: `/deploy-image-models`, `/vast-infra`, `/edit-bot-characters` etc. appearing directly in Discord's command palette. Zero-config discovery.

### Multi-Instance Profiles
Run multiple isolated Hermes instances from one installation. Each profile has separate config, memory, skills, and gateway. Maps well to claude-relay's per-channel config — each channel is effectively a different "profile" with its own cwd, system prompt, and tool restrictions.

### Voice Channel Integration
Join Discord voice channels, transcribe speech with Whisper (local/Groq/OpenAI), run through agent pipeline, respond with TTS (Edge TTS or ElevenLabs). Includes hallucination filtering (26 known Whisper phantom phrases). Wild for a coding agent but compelling for hands-free operation.

### Webhook Mode
v0.6.0 added webhook support as alternative to gateway polling. Better for production/scalable deployments. The bot receives events via HTTP POST instead of maintaining a WebSocket connection.

### Error Recovery Patterns
- Deleted reply target → silently retry without the reply-reference (don't crash).
- System messages (thread rename, pin) → skip reply-to, send as plain message.
- Rate limits → queue and retry with backoff.

### Interactive Components
Discord buttons for model selection — users click buttons inline instead of typing. Could be used for: choosing which Claude Code mode to run in, approving/denying tool permissions, selecting which channel config to apply.
