# GSD 2 - Claude Code Fork

This is a fork of [GSD 2](https://github.com/gsd-build/GSD-2) that replaces the Pi agent's LLM layer with Claude Code (`claude -p`).

## What this fork does

GSD's `/gsd auto` mode is a state machine that autonomously builds software. It reads `.gsd/` files, determines the next unit of work, builds a prompt, and dispatches it to its built-in Pi coding agent. The Pi agent calls the Anthropic API, executes tools, and returns results.

This fork swaps the LLM+tool-execution layer with `claude -p` (Claude Code in print mode). GSD's state machine, prompt construction, git strategy, and all extensions are untouched.

## Changed files

Only two files differ from upstream:

- **`src/claude-code-stream.ts`** (new) - `StreamFn` adapter that spawns `claude -p --output-format stream-json` and bridges the response back to the Pi agent loop as an `AssistantMessageEventStream`.
- **`src/cli.ts`** (4 lines added) - Swaps `session.agent.streamFn` to the Claude Code adapter after session creation.

## How it works

The adapter is injected by setting `session.agent.streamFn` in `src/cli.ts`. The `Agent.streamFn` property is public and mutable, read on every LLM call. The same Agent instance persists across all `newSession()` resets (which only clear messages). So every auto-mode unit dispatch flows through the adapter.

The adapter:
1. Extracts the last user message as the prompt
2. Spawns `claude -p` with `--output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence --model <model>`
3. Pipes the prompt via stdin (avoids arg length limits)
4. Passes GSD's system prompt via `--append-system-prompt`
5. Parses NDJSON events and streams them back to the TUI
6. Returns an AssistantMessage with no tool calls, so the agent loop exits and auto mode advances

## Building

```bash
npm install
npm run build
node dist/loader.js
```

## Syncing with upstream

```bash
git remote add upstream https://github.com/gsd-build/GSD-2.git
git fetch upstream
git checkout main
git merge upstream/main
npm install
npm run build
```

The only upstream file modified is `src/cli.ts` (4 lines). Conflicts are unlikely and trivial to resolve.
