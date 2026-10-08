# Agentic Harness

A SillyTavern extension that intercepts the generation pipeline and runs a hidden **Director → Author** flow:

1. **Director** (hidden call): when you send a message, a `generate_interceptor` pauses generation and runs a lightweight LLM call with the recent chat + the current world state. It returns JSON with `state_mutations` and `narrative_directives`.
2. **Harness logic** (deterministic code): mutations are validated against a whitelisted per-chat **schema** (types: `counter`, `flag`, `enum`, `text`), clamped, and applied. The LLM proposes; code decides.
3. **Author** (normal ST generation): the directive is injected into the outgoing prompt via `setExtensionPrompt`, then SillyTavern generates the reply normally. The Director exchange is never saved to the chat.

The state baseline lives in `chat_metadata` (per chat); every AI reply carries a snapshot of the state in `message.extra.ah`, so swipes and regenerates always start from the correct base state.

## Installation

Copy this folder into:

```
SillyTavern/public/scripts/extensions/third-party/agentic-harness/
```

Required files: `manifest.json`, `index.js`, `settings.html`, `style.css`. Then reload SillyTavern (or reload extensions).

## Usage

- **Settings → Agentic Harness** drawer: master switch, window visibility, schema template picker, Director tuning (context messages, directive depth, retries, response length).
- **Harness window** (draggable, from day one): 
  - **World State** — view/edit the current state JSON, or reset the baseline to the schema initials.
  - **Schema** — edit the field definitions the Director may mutate.
  - **Director Log** — every Director exchange for this chat (directives, applied/rejected mutations, raw output).
- **Templates**: Relationship Focus, Dungeon Crawl, Mystery / Investigation. A template initializes the schema and baseline for a new chat; you can edit the schema freely afterwards (the field `description` is what the Director reads to judge changes).

## Behavior notes

- Runs only on `normal`, `regenerate` and `swipe` generations; skipped for quiet/impersonate/continue calls and in **group chats** (v1).
- **Fail-open**: if the Director call fails or returns bad JSON, it retries once and then generates without the Director — your turn is never blocked.
- Requires no configuration: the Director call reuses whatever API/preset you already have configured in SillyTavern (`generateRaw`).

## Design

See `DesignDraft.txt` and the architecture notes in the repository history. v2 candidates: Editor pass (deterministic regex first), per-swipe snapshots, a cheaper Director model (custom backend / Connection Manager), and a schema-Architect agent that drafts a schema from the character card.
