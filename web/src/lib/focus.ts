/** What can take focus inside a dialog. Disabled controls are skipped, so they never become the first or last stop. */
export const FOCUSABLE = "button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href]";

/**
 * Where Tab (or Shift+Tab) should go to stay inside a dialog, or null to let the browser move focus normally.
 * Focus outside the dialog comes back to its first control. With one control the answer is always that control,
 * so Tab can't leave the dialog.
 */
export function trapTarget<T>(items: T[], active: unknown, shift: boolean): T | null {
  if (!items.length) return null;
  const first = items[0];
  const last = items[items.length - 1];
  if (!items.includes(active as T)) return first;
  if (shift && active === first) return last;
  if (!shift && active === last) return first;
  return null;
}
