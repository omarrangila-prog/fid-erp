/**
 * Takes the user to the first thing they need to fix.
 *
 * A purchase contract runs to five sections and a dozen line fields. Telling
 * somebody to "correct the highlighted fields" and leaving them to scroll for
 * the red one is the kind of small cruelty that makes a form feel hostile —
 * especially on a phone, where the highlighted field may be three screens down.
 *
 * Called after a failed save, once the errors have rendered.
 */
export function focusFirstError(container?: HTMLElement | null): void {
  // Deferred a frame: the errors have only just been set, so the invalid
  // attributes are not on the DOM yet when the caller runs.
  requestAnimationFrame(() => {
    const root = container ?? document;
    const invalid = root.querySelector<HTMLElement>(
      '[aria-invalid="true"], [data-field-error="true"]',
    );
    if (!invalid) return;

    // The control itself if this is a wrapper, so focus lands somewhere typable.
    const target =
      invalid.matches('input, select, textarea, button') || invalid.tabIndex >= 0
        ? invalid
        : invalid.querySelector<HTMLElement>('input, select, textarea, button') ?? invalid;

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // preventScroll, because scrollIntoView is already doing it and the two
    // together produce a visible jump.
    target.focus({ preventScroll: true });
  });
}

/**
 * How many fields need attention, phrased for a person.
 *
 * "Please correct the highlighted fields" does not say whether that is one
 * field or nine, which is the difference between finishing now and giving up.
 */
export function describeErrorCount(errors: Record<string, string>): string {
  const count = Object.keys(errors).length;
  if (count === 0) return '';
  if (count === 1) return 'One field needs attention.';
  return `${count} fields need attention.`;
}
