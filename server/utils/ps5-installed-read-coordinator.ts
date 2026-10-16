type ReadPriority = 'foreground' | 'background';

type InstalledRead = {
  priority: ReadPriority;
  settled: Promise<void>;
  run: () => void;
};

type ConsoleReads = {
  consoleId: string;
  active?: InstalledRead;
  foreground: InstalledRead[];
  background: InstalledRead[];
  reviews: number;
};

const consoles = new Map<string, ConsoleReads>();

function consoleReads(consoleId: string): ConsoleReads {
  let reads = consoles.get(consoleId);
  if (!reads) {
    reads = { consoleId, foreground: [], background: [], reviews: 0 };
    consoles.set(consoleId, reads);
  }
  return reads;
}

function schedule(reads: ConsoleReads) {
  if (reads.active) return;
  const next = reads.foreground.shift() ?? (reads.reviews ? undefined : reads.background.shift());
  if (next) {
    reads.active = next;
    next.run();
  } else if (!reads.reviews && consoles.get(reads.consoleId) === reads) {
    consoles.delete(reads.consoleId);
  }
}

/** The callback includes both the HTTP request and parsing its response. */
export function readPs5Installed<T>(
  consoleId: string,
  priority: ReadPriority,
  callback: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const reads = consoleReads(consoleId);
  return new Promise<T>((resolve, reject) => {
    let settle!: () => void;
    const settled = new Promise<void>((done) => {
      settle = done;
    });
    const queue = reads[priority];
    const cancel = () => {
      const index = queue.indexOf(task);
      if (index < 0) return;
      queue.splice(index, 1);
      signal?.removeEventListener('abort', cancel);
      reject(signal?.reason);
      settle();
      schedule(reads);
    };
    const task: InstalledRead = {
      priority,
      settled,
      run: () => {
        signal?.removeEventListener('abort', cancel);
        // An active caller owns its transport signal. Keep the slot until its
        // callback actually settles, even if it does not react to cancellation.
        void (async () => {
          try {
            signal?.throwIfAborted();
            resolve(await callback());
          } catch (error) {
            reject(error);
          } finally {
            reads.active = undefined;
            settle();
            schedule(reads);
          }
        })();
      },
    };
    queue.push(task);
    signal?.addEventListener('abort', cancel, { once: true });
    schedule(reads);
  });
}

function waitForBackground(drain: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return drain;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    void drain.then(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    });
  });
}

/** Hold background reads throughout a preview, including its profile probes. */
export async function withPs5InstalledReview<T>(
  consoleIds: string[],
  callback: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const states = [...new Set(consoleIds)].map(consoleReads);
  // Lease every selected console before waiting for any existing background
  // read. Foreground reads and other reviews remain allowed under these leases.
  for (const reads of states) reads.reviews++;
  try {
    const activeBackground = states.flatMap((reads) =>
      reads.active?.priority === 'background' ? [reads.active.settled] : [],
    );
    await waitForBackground(
      Promise.all(activeBackground).then(() => {}),
      signal,
    );
    signal?.throwIfAborted();
    return await callback();
  } finally {
    for (const reads of states) reads.reviews--;
    for (const reads of states) schedule(reads);
  }
}
