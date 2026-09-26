import { saveQbitSettings } from '../../utils/qbittorrent'

export default defineEventHandler(async (event) => saveQbitSettings(await readBody(event)))
