import { presetPage } from '../../utils/presets'
export default defineEventHandler(event => presetPage(getRouterParam(event, 'id'), getQuery(event)))
