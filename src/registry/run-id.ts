/**
 * Correlation id of ONE top-level run, in the same shape UiPath already emits:
 * `<epoch_ms>-<rand6>`. A composite and every step of its chain share it, so the whole
 * chain is recoverable from the `runs` table by grouping on run_id (ordered by `id`,
 * which is the only ordering available since the table has no step_index column).
 *
 * The random suffix is not decoration: a bare timestamp collides when two runs start in
 * the same millisecond, and two independent executions then become indistinguishable in
 * the log — which is exactly what happens today with the timestamp-only ids.
 */
export function newRunId(): string {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${Date.now()}-${rand}`;
}
