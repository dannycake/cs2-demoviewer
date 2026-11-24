// The cell at a table row's end that opens the figures under it (./Expansion) and shuts them: a
// button of its own, as a row that holds a link (a match's Replay) cannot be one, with a chevron
// that points down while shut and up while open. Screen readers hear `label` and whether it is
// open; the chevron is drawn in CSS (`.toggle` in profile.module.css).

import s from './profile.module.css';

export default function Toggle({
  open,
  controls,
  onToggle,
  label,
}: {
  open: boolean;
  /** The id of what it opens. */
  controls: string;
  onToggle: () => void;
  /** What it does, for screen readers: "Show Mirage stats", "Hide Mirage stats". */
  label: string;
}) {
  return (
    <button
      type="button"
      className={s.toggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={label}
      onClick={onToggle}
    >
      <span className={s.chevron} aria-hidden="true" />
    </button>
  );
}
