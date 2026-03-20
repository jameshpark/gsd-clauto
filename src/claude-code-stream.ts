import { createAssistantMessageEventStream } from '@gsd/pi-ai'
import type { AssistantMessage, Message } from '@gsd/pi-ai'
import type { StreamFn } from '@gsd/pi-agent-core'
import { spawn } from 'node:child_process'

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const

function extractTextContent(
  content: string | readonly { type: string; text?: string }[],
): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as { type: string; text?: string }[])
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
  }
  return ''
}

function buildPromptFromMessages(messages: readonly Message[]): string {
  if (messages.length === 0) return ''
  if (messages.length === 1) {
    const msg = messages[0]
    return msg.role === 'user' ? extractTextContent(msg.content) : ''
  }

  const historyParts: string[] = []
  for (const msg of messages.slice(0, -1)) {
    if (msg.role === 'user') {
      historyParts.push(`[User]\n${extractTextContent(msg.content)}`)
    } else if (msg.role === 'assistant') {
      historyParts.push(`[Assistant]\n${extractTextContent(msg.content)}`)
    }
  }

  const lastMsg = messages[messages.length - 1]
  const currentPrompt = lastMsg.role === 'user' ? extractTextContent(lastMsg.content) : ''

  return `<conversation_history>\n${historyParts.join('\n\n')}\n</conversation_history>\n\n${currentPrompt}`
}

/**
 * Creates a StreamFn that delegates to `claude -p` instead of calling the
 * Anthropic/OpenAI API directly. Claude Code executes tools internally and
 * returns final text, so the pi agent loop sees "no tool calls" and exits
 * cleanly, letting the auto state machine proceed.
 *
 * Uses --output-format stream-json to get NDJSON events as they happen,
 * allowing the TUI to show progress during execution.
 */
export function createClaudeCodeStreamFn(): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream()

    const promptText = buildPromptFromMessages(context.messages)

    // Prompt piped via stdin (no positional arg) to avoid OS argument length
    // limits; GSD auto prompts include full task context and can be very large.
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--model', model.id,
    ]

    if (context.systemPrompt) {
      args.push('--append-system-prompt', context.systemPrompt)
    }

    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    child.stdin.end(promptText)

    let emittedStart = false
    let finalized = false
    let lastText = ''
    let lineBuf = ''

    child.stdout.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString()
      const lines = lineBuf.split('\n')
      // Keep the last (possibly incomplete) line in the buffer
      lineBuf = lines.pop()!

      for (const line of lines) {
        if (!line.trim()) continue
        let event: any
        try { event = JSON.parse(line) } catch { continue }

        if (event.type === 'assistant') {
          // Extract text content from the assistant message
          const textBlocks = (event.message?.content ?? [])
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
          const text = textBlocks.join('\n')
          if (text) lastText = text

          if (!emittedStart) {
            emittedStart = true
            const partial = makeAssistantMessage(lastText)
            stream.push({ type: 'start', partial })
          } else {
            const partial = makeAssistantMessage(lastText)
            stream.push({ type: 'text_delta', contentIndex: 0, delta: '', partial })
          }
        }

        if (event.type === 'result') {
          const resultText = event.result ?? lastText
          const costUsd = event.total_cost_usd ?? 0
          const msg = makeAssistantMessage(resultText, costUsd)

          if (!emittedStart) {
            emittedStart = true
            stream.push({ type: 'start', partial: msg })
          }

          finalized = true
          if (event.is_error) {
            msg.stopReason = 'error'
            msg.errorMessage = resultText
            stream.push({ type: 'error', reason: 'error', error: msg })
          } else {
            stream.push({ type: 'done', reason: 'stop', message: msg })
          }
        }
      }
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    if (options?.signal) {
      const signal = options.signal
      const onAbort = () => {
        child.kill('SIGTERM')
        if (!emittedStart) {
          const msg = makeAssistantMessage('')
          msg.stopReason = 'aborted'
          stream.push({ type: 'error', reason: 'aborted', error: msg })
        }
      }
      if (signal.aborted) {
        child.kill('SIGTERM')
        const msg = makeAssistantMessage('')
        msg.stopReason = 'aborted'
        stream.push({ type: 'error', reason: 'aborted', error: msg })
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
        child.on('close', () => signal.removeEventListener('abort', onAbort))
      }
    }

    child.on('error', (err) => {
      const msg = makeAssistantMessage('')
      msg.stopReason = 'error'
      msg.errorMessage = err.message
      if (!emittedStart) stream.push({ type: 'start', partial: msg })
      stream.push({ type: 'error', reason: 'error', error: msg })
    })

    child.on('close', (code) => {
      if (finalized) return
      // claude exited without emitting a result event (crash, signal, etc.)
      const msg = makeAssistantMessage(lastText)
      if (code !== 0) {
        msg.stopReason = 'error'
        msg.errorMessage = `claude exited with code ${code}: ${stderr}`
      }
      if (!emittedStart) stream.push({ type: 'start', partial: msg })
      if (code !== 0) {
        stream.push({ type: 'error', reason: 'error', error: msg })
      } else {
        stream.push({ type: 'done', reason: 'stop', message: msg })
      }
    })

    return stream
  }
}

function makeAssistantMessage(text: string, costUsd = 0): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic',
    provider: 'anthropic',
    model: 'claude-code',
    usage: costUsd > 0
      ? { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost, total: costUsd } }
      : { ...ZERO_USAGE },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}
