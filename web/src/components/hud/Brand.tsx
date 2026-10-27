// Top left: the cs.skunk.to mark and wordmark, the map and where the match was played.

import { usePlayback } from '../../state/store';
import { brandModel } from './models';
import styles from './hud.module.css';

export default function Brand() {
  const pack = usePlayback((s) => s.pack);
  const b = pack ? brandModel(pack.header) : null;
  return (
    <div className={styles.brand}>
      <a
        className={styles.wordmark}
        href="/"
        aria-label="cs.skunk.to: upload another demo"
      >
        <img src="/skunk-mark.svg" alt="" width={28} height={24} />
        <span>cs.skunk.to</span>
      </a>
      {b && (
        <span className={styles.match}>
          <span className={styles.mapName}>{b.map}</span>
          <span className={styles.place}>{b.place}</span>
        </span>
      )}
    </div>
  );
}
