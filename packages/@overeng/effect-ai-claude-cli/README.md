# @overeng/effect-ai-claude-cli

Effect AI LanguageModel provider that delegates to the `claude` CLI.

## Why?

Use your existing **Claude Code subscription** instead of paying for API calls. The Claude CLI authenticates via your subscription, which can be significantly cheaper than direct API usage.

## Installation

```bash
pnpm add @overeng/effect-ai-claude-cli @effect/platform-node effect
```

Requires the `claude` CLI to be installed and authenticated:

```bash
# Install Claude CLI (if not already)
npm install -g @anthropic-ai/claude-cli

# Authenticate
claude auth
```

## Usage

```ts
import { NodeServices } from '@effect/platform-node'
import { Chat } from 'effect/unstable/ai'
import { ClaudeCli } from '@overeng/effect-ai-claude-cli'
import { Effect, Layer } from 'effect'

const program = Effect.gen(function* () {
  const chat = yield* Chat.fromPrompt([{ role: 'system', content: 'You are a helpful assistant.' }])
  const response = yield* chat.generateText({ prompt: 'Hello!' })
  console.log(response.text)
})

const layer = ClaudeCli.layer({ model: 'sonnet' }).pipe(Layer.provide(NodeServices.layer))

Effect.runPromise(program.pipe(Effect.provide(layer)))
```

## API

### ClaudeCli.layer

Creates a LanguageModel layer that delegates to the `claude` CLI.

```ts
ClaudeCli.layer(options?: ClaudeCliOptions)
```

#### Options

| Option         | Type     | Default     | Description                            |
| -------------- | -------- | ----------- | -------------------------------------- |
| `model`        | `string` | CLI default | Model name (`sonnet`, `opus`, `haiku`) |
| `allowedTools` | `string` | `''`        | Tools to allow (empty disables tools)  |

### ClaudeCli.make

Creates a LanguageModel service effect (for custom layer composition).

```ts
ClaudeCli.make(options?: ClaudeCliOptions)
```

## Supported Models

The CLI accepts short model names:

- `sonnet` - Claude Sonnet (default)
- `opus` - Claude Opus
- `haiku` - Claude Haiku

## Dependencies

- `effect` - Effect AI and child-process service interfaces
- `@effect/platform-node` - Node implementations of the required platform services

## When to use this vs `@effect/ai-anthropic`

| Use Case                       | Package                         |
| ------------------------------ | ------------------------------- |
| Claude Code subscription       | `@overeng/effect-ai-claude-cli` |
| Direct API with API key        | `@effect/ai-anthropic`          |
| Production with usage tracking | `@effect/ai-anthropic`          |
| Local dev / scripting          | `@overeng/effect-ai-claude-cli` |
