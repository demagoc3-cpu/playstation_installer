import { clearEvents } from '../../utils/event-log'

export default defineEventHandler(() => { clearEvents(); return { ok: true } })
