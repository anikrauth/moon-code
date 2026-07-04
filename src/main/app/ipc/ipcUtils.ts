// @ts-nocheck
import * as fs from 'fs';
import * as path from 'path';

// Atomically create `dir` iff it doesn't already exist, throwing the given
// message if it does. Fixes a TOCTOU race across the skill-install call sites
// below: a plain `existsSync` check followed by a separate `mkdirSync` call
// left a window where two concurrent installs of the same skill name could
// both pass the check and one silently clobber the other's directory.
// `mkdirSync(dir, { recursive: false })` is atomic at the OS level and throws
// EEXIST if the dir is already there, so we can turn that into the same
// friendly error message instead. Parent dirs are ensured separately (with
// `recursive: true`, which is idempotent and race-free) since the final
// non-recursive mkdir requires the parent to already exist.
export function mkdirExclusive(dir: string, alreadyExistsMessage: string) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir, { recursive: false });
  } catch (e: any) {
    if (e && e.code === 'EEXIST') throw new Error(alreadyExistsMessage);
    throw e;
  }
}

// Bug #9 hardening: configStore/sessionStore handlers are fully synchronous
// today (confirmed — no `await` sits between reading and mutating state in
// either store), so there's no live race to fix. This serializes IPC calls
// through a single promise chain anyway, mirroring the renderer's own
// `saveChainRef` pattern (App.tsx), so that if a future change makes any
// wrapped handler asynchronous mid-mutation, concurrent invocations still
// can't interleave — they'll simply queue instead of corrupting state.
export function withLock<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  let chain: Promise<any> = Promise.resolve();
  return (...args: Parameters<T>) => {
    const run = chain.then(() => fn(...args));
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
}
