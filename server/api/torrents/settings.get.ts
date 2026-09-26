import { getQbitStatus } from '../../utils/qbittorrent'

export default defineEventHandler(() => getQbitStatus())
