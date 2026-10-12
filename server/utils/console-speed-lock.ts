import { createError } from 'h3'
const targets = new Set<string>()
export const consoleSpeedLocked = (id: string) => targets.has(id)
export function assertNoConsoleSpeedTest(id: string) {
  if (targets.has(id)) throw createError({ statusCode: 409, message: 'Идёт тест скорости выбранной приставки. Дождитесь результата или остановите тест.' })
}
export function acquireConsoleSpeedTest(id: string) { assertNoConsoleSpeedTest(id); targets.add(id); return () => targets.delete(id) }
