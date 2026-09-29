import { getEvents } from '../../utils/event-log'

export default defineEventHandler((event) => getEvents(Number(getQuery(event).after) || 0))
