/**
 * Test page script that connects to SharedWorker and listens for broadcast logs.
 */
import { Effect, Stream } from 'effect'

import { logStream, formatLogEntry, type BroadcastLogEntry } from '../../BroadcastLogger.ts'

/** Expose received logs for Playwright assertions */
declare global {
  interface Window {
    receivedLogs: BroadcastLogEntry[]
    workerReady: boolean
    workerPort: MessagePort | null
  }
}

window.receivedLogs = []
window.workerReady = false
window.workerPort = null

const statusEl = document.getElementById('status')!
const logsEl = document.getElementById('logs')!

const appendLog = (entry: BroadcastLogEntry) => {
  window.receivedLogs.push(entry)
  const div = document.createElement('div')
  div.textContent = formatLogEntry(entry)
  div.className = 'log-entry'
  logsEl.appendChild(div)
}

/** Start listening for broadcast logs */
const startLogListener = logStream.pipe(
  Stream.tap((entry) =>
    Effect.sync(() => {
      appendLog(entry)
    }),
  ),
  Stream.runDrain,
)

/** Connect to SharedWorker */
const connectWorker = () => {
  const worker = new SharedWorker(new URL('./test-worker.ts', import.meta.url), {
    type: 'module',
    name: 'test-worker',
  })

  worker.port.start()
  window.workerPort = worker.port

  worker.port.addEventListener('message', (e) => {
    if (e.data.type === 'done') {
      statusEl.textContent = 'Worker done'
    }
  })

  window.workerReady = true
  statusEl.textContent = 'Worker ready'
}

/** Initialize */
const init = async () => {
  connectWorker()

  // Run log listener in background (scoped so it cleans up on page unload)
  void startLogListener.pipe(Effect.scoped, Effect.runFork)
}

init()
