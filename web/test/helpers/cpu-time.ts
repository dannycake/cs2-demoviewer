// What a piece of a test's work costs in CPU time, for the tests that guard against a slow build
// (a pass gone quadratic): the time this thread spent running, which the other processes on the
// machine do not stretch as they do the wall clock (under a load average of 19, a build that
// takes 0.4 s ran past a 1 s limit). A busy core's other hyperthread or a cold cache can still
// slow the work itself, so the limits keep several times the margin over what it takes.

/** Runs `work` and gives its value and the CPU milliseconds this thread spent on it. */
export function cpuTimed<T>(work: () => T): { value: T; ms: number } {
  const t0 = process.threadCpuUsage();
  const value = work();
  const d = process.threadCpuUsage(t0);
  return { value, ms: (d.user + d.system) / 1000 };
}
