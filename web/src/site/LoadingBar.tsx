// A thin crimson bar along the top of the screen while something loads (a page's code, a
// profile, Steam's facts, a match and its 3D view): it says the page is working, not empty.

import s from './LoadingBar.module.css';

export default function LoadingBar() {
  return (
    <div className={s.bar} role="progressbar" aria-label="Loading">
      <span />
    </div>
  );
}
