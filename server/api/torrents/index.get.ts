import { getTorrents } from '../../utils/qbittorrent'

export default defineEventHandler(() => getTorrents())
