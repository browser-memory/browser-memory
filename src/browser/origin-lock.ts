/**
 * Per-origin read-write lock for the REPLAY worker tabs.
 *
 * Why it exists: worker-tabs.ts keeps ONE live tab per origin, and nothing used to
 * serialize concurrent runs against it. Two parallel `run` calls on the same origin
 * raced: both called page.goto and one died with net::ERR_ABORTED (measured on
 * doordash/walmart), or a navigation destroyed the other run's in-flight evaluate.
 *
 * The fix is not "serialize everything" — a fetch-replay run on a tab already sitting
 * on its origin is a single page.evaluate, and N of those are safe AND profitable to
 * run at once (the browser parallelizes the in-page fetches). So the lock has two
 * grades, like a classic RW lock keyed by origin:
 *   - exclusive: anything that navigates or drives the DOM (playwright recipes, and
 *     the warm-up goto of a cold fetch-replay). One at a time per origin.
 *   - shared: the evaluate of a fetch-replay. Any number at a time, but never while
 *     an exclusive holder is active.
 * Grants are FIFO so writers don't starve behind a stream of readers, and an exclusive
 * holder can DOWNGRADE to shared without a gap (used right after the warm-up: nobody
 * can slip a navigation in between the goto and the evaluate it was for).
 */

type Waiter = { exclusive: boolean; grant: () => void };

class RwLock {
  /** Number of shared holders, or -1 while the single exclusive holder runs. */
  private active = 0;
  private queue: Waiter[] = [];

  private pump(): void {
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.exclusive) {
        if (this.active !== 0) return;
        this.active = -1;
        this.queue.shift()!.grant();
        return;
      }
      // Shared: admit while nothing exclusive is running. FIFO stops here at the
      // first queued exclusive, so a writer is never starved by later readers.
      if (this.active === -1) return;
      this.active += 1;
      this.queue.shift()!.grant();
    }
  }

  acquire(exclusive: boolean): Promise<void> {
    return new Promise((grant) => {
      this.queue.push({ exclusive, grant });
      this.pump();
    });
  }

  release(exclusive: boolean): void {
    this.active = exclusive ? 0 : this.active - 1;
    this.pump();
  }

  /** Exclusive → shared atomically: no other waiter can run in between. */
  downgrade(): void {
    this.active = 1;
    this.pump(); // other queued shareds may join right away
  }

  get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }
}

const locks = new Map<string, RwLock>();

function lockFor(key: string): RwLock {
  let lock = locks.get(key);
  if (!lock) {
    lock = new RwLock();
    locks.set(key, lock);
  }
  return lock;
}

/** Handle for the two-phase use of withOriginPage: exclusive prepare, shared body. */
export interface OriginHold {
  /** Exclusive → shared without a gap. Call at most once, before release. */
  downgrade(): void;
  release(): void;
}

/** Acquires the origin's lock. The caller MUST release() (or downgrade() + release()). */
export async function acquireOrigin(
  key: string,
  exclusive: boolean,
): Promise<OriginHold> {
  const lock = lockFor(key);
  await lock.acquire(exclusive);
  let grade = exclusive;
  let done = false;
  return {
    downgrade(): void {
      if (done || !grade) return;
      grade = false;
      lock.downgrade();
    },
    release(): void {
      if (done) return;
      done = true;
      lock.release(grade);
      if (lock.idle) locks.delete(key);
    },
  };
}

/** For tests. */
export function resetOriginLocks(): void {
  locks.clear();
}
