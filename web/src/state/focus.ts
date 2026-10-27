// Where a key was typed. A key typed into a text field (or a select's type-ahead) is the
// field's, not a shortcut (`isTextEntry`). Space on a checkbox, a radio or a button the
// keyboard focused presses it, where Space on one the mouse just clicked plays and pauses
// (`isPressable`): which it was is noted as focus arrives (`trackFocus`).

/** The inputs Space presses: a checkbox, a radio or a button. */
const PRESSED_INPUTS = ['checkbox', 'radio', 'button', 'submit', 'reset'];

/** Whether `el` matches `:focus-visible`; false in a browser without it. */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

/**
 * How each element got focus, as `trackFocus` noted it: true by the keyboard. It is read when
 * focus arrives because a browser makes the focused element match `:focus-visible` as soon as
 * a key goes down on it, the Space this is for included.
 */
const keyboardFocused = new WeakMap<object, boolean>();

/**
 * Notes, for each element that takes focus in `doc`, whether the keyboard brought it there
 * (`:focus-visible` as it arrives), and that a press on a button or input is the mouse's;
 * `isPressable` reads it. Returns the removal of its listeners.
 */
export function trackFocus(
  doc: Pick<Document, 'addEventListener' | 'removeEventListener'>
): () => void {
  const focused = (e: Event) => {
    if (e.target instanceof Element)
      keyboardFocused.set(e.target, focusVisible(e.target));
  };
  const pressed = (e: Event) => {
    const el =
      e.target instanceof Element ? e.target.closest('button, input') : null;
    if (el) keyboardFocused.set(el, false);
  };
  doc.addEventListener('focusin', focused, true);
  doc.addEventListener('pointerdown', pressed, true);
  return () => {
    doc.removeEventListener('focusin', focused, true);
    doc.removeEventListener('pointerdown', pressed, true);
  };
}

/**
 * A control the keyboard focused that Space (and Enter) acts on: a checkbox, a radio or a
 * button (a select is a text entry already). Space there is the control's, not play and pause,
 * so the keyboard can toggle the HUD's checkboxes. One the mouse focused (a camera button just
 * clicked) is not: Space plays and pauses there, as it did. Which it was is `:focus-visible`
 * when it took focus (`trackFocus`), else now; a browser without it plays and pauses.
 */
export function isPressable(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined') return false;
  if (!(target instanceof HTMLElement)) return false;
  const control =
    (typeof HTMLButtonElement !== 'undefined' &&
      target instanceof HTMLButtonElement) ||
    (target instanceof HTMLInputElement &&
      PRESSED_INPUTS.includes(target.type));
  if (!control) return false;
  return keyboardFocused.get(target) ?? focusVisible(target);
}

/** Keys typed into a text field (or a select's type-ahead) are not shortcuts. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined') return false;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement)
    return target.type !== 'range' && !PRESSED_INPUTS.includes(target.type);
  return false;
}
