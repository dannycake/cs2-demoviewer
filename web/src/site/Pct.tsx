// A percentage as the site sets it: the figure, then its sign a little smaller.

import { DASH } from './format';

export default function Pct({ value }: { value: number | null }) {
  if (value === null) return <>{DASH}</>;
  return (
    <>
      {Math.round(value)}
      <span className="pct">%</span>
    </>
  );
}
