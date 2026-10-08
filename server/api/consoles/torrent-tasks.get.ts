import { getTaskVisibility } from '../../utils/task-visibility'
export default defineEventHandler(event=>{ setHeader(event,'Cache-Control','no-store');return {hiddenTorrents:getTaskVisibility().torrents} })
