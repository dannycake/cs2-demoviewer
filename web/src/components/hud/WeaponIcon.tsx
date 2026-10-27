// A weapon's white side silhouette `height` em tall, or its name where there is none.

import { spriteStyle } from './weapon-sprite';
import styles from './hud.module.css';

export default function WeaponIcon({
  name,
  label,
  height,
}: {
  /** The silhouette's name (`ak47`, `knife_t`, `smokegrenade`, ...). */
  name: string;
  /** What it is called, for screen readers and as the fallback text. */
  label: string;
  /** In em of the surrounding text. */
  height: number;
}) {
  const style = spriteStyle(name, height);
  if (!style) return <span className={styles.weaponText}>{label}</span>;
  return (
    <span
      className={styles.weapon}
      style={style}
      role="img"
      aria-label={label}
    />
  );
}
