/** PS5 service builds this WEB trusts like the hardware-qualified 029c.
 * 029d is 029c plus one fix: it also clears the leftover registration of a
 * title it published itself after that title's files were deleted.
 * 029e retains these routes and adds system unregister for any installed title.
 * Its new unregister path still needs a separate hardware check. */
export const PS5_QUALIFIED_BUILDS: ReadonlySet<string> = new Set([
  'ps5-service-pkg-context-029c-sse2',
  'ps5-service-pkg-context-029d-sse2',
  'ps5-service-pkg-context-029e-sse2',
]);

/** Builds that clear their own orphaned registration (needed to reinstall a
 * Folder/image: its files are deleted first, then its registration). */
const ORPHAN_CLEANUP_BUILDS: ReadonlySet<string> = new Set([
  'ps5-service-pkg-context-029d-sse2',
  'ps5-service-pkg-context-029e-sse2',
]);

export const ps5BuildQualified = (buildId: unknown) =>
  typeof buildId === 'string' && PS5_QUALIFIED_BUILDS.has(buildId);
export const ps5BuildClearsOwnOrphans = (buildId: unknown) =>
  typeof buildId === 'string' && ORPHAN_CLEANUP_BUILDS.has(buildId);

/** A bundle manifest may name the firmware its ELF was checked on ("13.60",
 * "12.20,13.60") or omit it for an untested candidate (030b+). It describes the
 * artifact; it does not gate a console: the running service reports what it can
 * do on its own firmware. */
export const ps5ManifestFirmware = (value: unknown) =>
  value === undefined ||
  value === '' ||
  (typeof value === 'string' && /^\d{1,2}\.\d{2}(?:,\d{1,2}\.\d{2}){0,15}$/.test(value));

/** Clears an orphaned registration. A service with capability flags (030b+)
 * decides by them, and a present false is final; only a service without the
 * flags falls back to the measured build list (029d/029e). */
export const ps5ClearsOwnOrphans = (buildId: unknown, capabilities?: any) =>
  typeof capabilities?.orphanCleanup === 'boolean' ||
  typeof capabilities?.systemUninstall === 'boolean'
    ? capabilities.orphanCleanup === true || capabilities.systemUninstall === true
    : ps5BuildClearsOwnOrphans(buildId);
