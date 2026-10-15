let users = 0;
let removeListeners: (() => void) | undefined;

/** Share one preview and one input-mode listener across the library rows.
 * Scrolling a focused row beneath a stationary pointer must not select a
 * different game's preview. Real pointer movement restores hover behavior. */
export function useGamePreview() {
  const activePreview = useState('packageflow-game-preview', () => '');
  const keyboardPreview = useState('packageflow-game-preview-keyboard', () => false);
  onMounted(() => {
    if (users++ !== 0) return;
    const key = () => {
      keyboardPreview.value = true;
    };
    const pointer = (event: PointerEvent) => {
      if (event.type === 'pointerdown' || event.movementX || event.movementY)
        keyboardPreview.value = false;
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointermove', pointer, true);
    window.addEventListener('pointerdown', pointer, true);
    removeListeners = () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointermove', pointer, true);
      window.removeEventListener('pointerdown', pointer, true);
    };
  });
  onBeforeUnmount(() => {
    if (--users === 0) {
      removeListeners?.();
      removeListeners = undefined;
    }
  });
  return { activePreview, keyboardPreview };
}
