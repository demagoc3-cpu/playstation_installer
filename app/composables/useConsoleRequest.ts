/** A component belongs to one device. Disposing it stops follow-up requests,
 * without replaying or cancelling a command already accepted by that device. */
export function useConsoleRequest() {
  let disposed = false;
  onBeforeUnmount(() => {
    disposed = true;
  });
  return async <T = unknown>(path: string, options?: Parameters<typeof $fetch>[1]): Promise<T> => {
    if (disposed) throw new DOMException('Console view closed', 'AbortError');
    const result = await $fetch<T>(path, options);
    if (disposed) throw new DOMException('Console view closed', 'AbortError');
    return result as T;
  };
}
