import { listPresets } from '../../utils/presets'
export default defineEventHandler(event => listPresets(getQuery(event)))
