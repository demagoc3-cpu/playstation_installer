export type LogLevel = 'info' | 'warn' | 'error'
export interface LogEntry { id: number; time: number; level: LogLevel; text: string; count: number }

// Recent server events, shown in the web UI's "Журнал" panel. Memory only:
// the log starts empty after a server restart.
const MAX_ENTRIES = 300
const entries: LogEntry[] = []
let nextId = 1

function describe(value: unknown) {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** Prints "[PackageFlow] …" to the console and records the event for the UI. Repeats collapse into ×N. */
export function logEvent(level: LogLevel, text: string, ...extra: unknown[]) {
  const print = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error
  print(`[PackageFlow] ${text}`, ...extra)
  const full = [text, ...extra.map(describe)].filter(Boolean).join(' ')
  const last = entries.at(-1)
  if (last && last.text === full && last.level === level) {
    entries.pop()
    entries.push({ ...last, id: nextId++, time: Date.now(), count: last.count + 1 })
    return
  }
  entries.push({ id: nextId++, time: Date.now(), level, text: full, count: 1 })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

export function getEvents(after = 0) { return { entries: entries.filter((entry) => entry.id > after), lastId: nextId - 1 } }
export function clearEvents() { entries.length = 0 }
