import { getInstallationPreference } from '../../utils/installation-preference'

export default defineEventHandler(() => ({ transport: getInstallationPreference() }))
