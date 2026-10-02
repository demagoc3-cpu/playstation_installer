import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectAutomaticPackages } from '../utils/automatic-package-selection.ts'

const pkg = (id: string, contentType: string, fileName: string, installedAt?: number) => ({
  id, contentType, fileName, installedAt, titleId: 'CUSA05954', title: 'LEGO Harry Potter',
  appVersion: contentType === 'PS4GD' ? '01.00' : '01.01', installOrder: contentType === 'PS4GD' ? 0 : 1,
})

test('automatic installation sends the base, then Fix, then Rus without a prompt', () => {
  const items = [pkg('rus', 'PS4GP', '1.01 Rus.pkg'), pkg('base', 'PS4GD', '1.00 Game.pkg'), pkg('fix', 'PS4GP', '1.01 Fix Game Info.pkg')]
  assert.deepEqual(selectAutomaticPackages(items).map((item) => item.id), ['base', 'fix', 'rus'])
})

test('an installed Rus patch does not cause the older Fix variant to be sent again', () => {
  const items = [pkg('rus', 'PS4GP', '1.01 Rus.pkg', Date.now()), pkg('fix', 'PS4GP', '1.01 Fix Game Info.pkg')]
  assert.deepEqual(selectAutomaticPackages(items), [])
})

test('an installed Fix variant resumes at Rus', () => {
  const items = [pkg('rus', 'PS4GP', '1.01 Rus.pkg'), pkg('fix', 'PS4GP', '1.01 Fix Game Info.pkg', Date.now())]
  assert.deepEqual(selectAutomaticPackages(items).map((item) => item.id), ['rus'])
})

test('a torrent containing only Fix does not replace Rus installed from another torrent', () => {
  const fix = pkg('fix', 'PS4GP', '1.01 Fix Game Info.pkg')
  const rus = pkg('rus', 'PS4GP', '1.01 Rus.pkg', Date.now())
  assert.deepEqual(selectAutomaticPackages([fix], [fix, rus]), [])
})

test('console state overrides stale local installation marks for base and patch', () => {
  const base = pkg('base', 'PS4GD', '1.00 Game.pkg', Date.now())
  const patch = pkg('patch', 'PS4GP', '1.01 Rus.pkg', Date.now())
  const console = { baseTitleIds: new Set<string>(), patchTitleIds: new Set<string>(), dlcContentIds: new Set<string>() }
  assert.deepEqual(selectAutomaticPackages([base, patch], [base, patch], console).map((item) => item.id), ['base', 'patch'])
  console.baseTitleIds.add('CUSA05954')
  assert.deepEqual(selectAutomaticPackages([base, patch], [base, patch], console).map((item) => item.id), ['patch'])
})

test('license-only DLC uses confirmed installation history while its base game exists', () => {
  const license = { ...pkg('license', 'PS4AL', 'costume.pkg', Date.now()), contentId: 'EP9000-CUSA05954_00-LICENSEONLY0001' }
  const console = { baseTitleIds: new Set(['CUSA05954']), patchTitleIds: new Set<string>(), dlcContentIds: new Set<string>() }
  assert.deepEqual(selectAutomaticPackages([license], [license], console), [])
  console.baseTitleIds.clear()
  assert.deepEqual(selectAutomaticPackages([license], [license], console).map((item) => item.id), ['license'])
})
