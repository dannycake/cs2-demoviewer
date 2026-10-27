// A hand-driven requestAnimationFrame (`FrameScheduler`): `step(ms)` runs the callbacks pending
// at now + ms.

import type { FrameScheduler } from '../../src/state/clock';

export function fakeFrames() {
  let now = 1000;
  let next = 1;
  const pending = new Map<number, (t: number) => void>();
  const sched: FrameScheduler = {
    request(cb) {
      const id = next++;
      pending.set(id, cb);
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
  };
  return {
    sched,
    get pending() {
      return pending.size;
    },
    // As in the browser: runs the callbacks pending when the frame starts, in request
    // order, skipping any that an earlier callback of the same frame cancelled.
    step(ms: number) {
      now += ms;
      for (const id of [...pending.keys()]) {
        const cb = pending.get(id);
        if (!cb) continue;
        pending.delete(id);
        cb(now);
      }
    },
  };
}
