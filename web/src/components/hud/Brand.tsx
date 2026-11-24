// Top left, under the minimap: the map and where the match was played (the site's bar above the
// viewer says which site this is).

import { usePlayback } from '../../state/store';
import { brandModel } from './models';
import styles from './hud.module.css';

export default function Brand() {
  const pack = usePlayback((s) => s.pack);
  const b = pack ? brandModel(pack.header) : null;
  return (
    <div className={styles.brand}>
      {b && (
        <span className={styles.match}>
          <span className={styles.mapName}>{b.map}</span>
          <span className={styles.place}>{b.place}</span>
        </span>
      )}
    </div>
  );
}
