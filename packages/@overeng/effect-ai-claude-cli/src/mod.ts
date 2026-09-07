/**
 * Claude CLI LanguageModel provider for Effect AI
 *
 * Implements Effect AI's LanguageModel interface by delegating to the `claude` CLI.
 * This allows using your Claude Code subscription instead of paying for API calls.
 *
 * @example
 * ```ts
 * import { NodeServices } from '@effect/platform-node'
 * import { Chat } from 'effect/unstable/ai'
 * import { ClaudeCli } from '@overeng/effect-ai-claude-cli'
 * import { Effect, Layer } from 'effect'
 *
 * const program = Effect.gen(function* () {
 *   const chat = yield* Chat.fromPrompt([
 *     { role: 'system', content: 'You are a helpful assistant.' },
 *   ])
 *   const response = yield* chat.generateText({ prompt: 'Hello!' })
 *   console.log(response.text)
 * })
 *
 * const layer = ClaudeCli.layer({ model: 'sonnet' }).pipe(Layer.provide(NodeServices.layer))
 *
 * Effect.runPromise(program.pipe(Effect.provide(layer)))
 * ```
 */

/** Claude CLI LanguageModel provider for Effect AI */
export * as ClaudeCli from './claude-cli.ts'
export * from './errors.ts'
