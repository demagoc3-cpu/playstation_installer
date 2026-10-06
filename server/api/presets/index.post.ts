import { mutatePreset } from '../../utils/presets'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(async event => { assertInstallationOrigin(event, true); return mutatePreset(await readBody(event)) })
