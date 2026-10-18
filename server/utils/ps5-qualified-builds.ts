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
