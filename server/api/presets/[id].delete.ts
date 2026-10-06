import { deletePreset } from '../../utils/presets'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(event => { assertInstallationOrigin(event); return deletePreset(getRouterParam(event, 'id')) })
