import { getTorrentFiles } from '../../../utils/qbittorrent'

export default defineEventHandler((event) => getTorrentFiles(getRouterParam(event, 'hash') || ''))
