// A line of words with figures in it ("Round 7", "3 kills, 177 damage", "1v2 clutch"), its figures
// set in JetBrains Mono and its words in the face around them: the look's rule, Archivo for words
// and mono for every number. An ordinal's figure ("1st half") stays with its word, as does "3D".

import styles from './hud.module.css';

/** A run of figures (with its decimal, thousands or clock marks, and a percent sign). */
const FIGURES = /(\d+(?:[.,:]\d+)*%?)(?!\d|st|nd|rd|th|D\b)/;

export default function Digits({ text }: { text: string }) {
  const parts = text.split(FIGURES);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className={styles.num}>
        {part}
      </span>
    ) : (
      part
    )
  );
}
