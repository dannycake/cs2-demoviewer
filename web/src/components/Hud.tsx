// The debug corner (`?debug=1`): the quality preset (with the frame rate measured at
// `medium` when it was picked from that, or "(device)" when the device set it), frames per
// second and triangles drawn, read from the scene's stats twice a second. While paused the
// scene draws only on change, so its frame rate means nothing and the corner says so instead.

import { useEffect, useState } from 'react';
import { usePlayback } from '../state/store';
import styles from './Hud.module.css';

const REFRESH_MS = 500;

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}

export default function Hud({
  stats,
}: {
  stats: {
    readonly fps: number;
    readonly tris: number;
    readonly probe: number;
  };
}) {
  const [, setTick] = useState(0);
  const playing = usePlayback((s) => s.playing);
  const quality = usePlayback((s) => s.quality);
  const from = usePlayback((s) => s.qualityFrom);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className={styles.hud} data-testid="hud">
      <span data-testid="hud-quality" data-quality={quality}>
        {from === 'detected'
          ? `${quality} (auto, ${stats.probe.toFixed(0)} fps)`
          : from === 'device'
            ? `${quality} (device)`
            : quality}
      </span>
      <span>{playing ? `${stats.fps.toFixed(0)} fps` : 'paused'}</span>
      <span>{formatCount(stats.tris)} tris</span>
    </div>
  );
}
