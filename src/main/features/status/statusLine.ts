/**
 * statusLine.ts
 *
 * A Claude-Code-style status line for a terminal coding agent:
 *   ✻ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)
 *
 * How the real thing works, in short:
 *  1. A spinner frame cycles on a fixed tick (~80-120ms) using Braille
 *     dot characters, redrawn on the SAME terminal line via "\r" + clear.
 *  2. A random "verb" (Pondering, Simmering, Cogitating...) is picked once
 *     per turn and stays fixed until the turn ends.
 *  3. An elapsed-time counter increments off wall-clock time, not the tick
 *     count (so it survives slow/dropped frames).
 *  4. A token counter is updated externally as the model streams tokens.
 *  5. Raw-mode stdin listens for the Esc key and fires an AbortController
 *     so the in-flight request can be cancelled.
 *  6. Nothing is ever appended with "\n" until the turn finishes — every
 *     redraw overwrites the previous line in place.
 */

import * as readline from "node:readline";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const VERBS = [
  "Pondering", "Simmering", "Cogitating", "Marinating", "Noodling",
  "Percolating", "Ruminating", "Synthesizing", "Untangling", "Whirring",
];

const TICK_MS = 100;

export interface StatusLineOptions {
  /** Called when the user presses Esc while the status line is active. */
  onInterrupt?: () => void;
  /** Stream to write to. Defaults to process.stdout. */
  stream?: NodeJS.WriteStream;
}

export class StatusLine {
  private frame = 0;
  private tokens = 0;
  private startedAt = 0;
  private verb: string;
  private timer: NodeJS.Timeout | null = null;
  private keypressHandler: ((str: string, key: readline.Key) => void) | null = null;
  private stream: NodeJS.WriteStream;
  private onInterrupt?: () => void;
  private lastLineLength = 0;

  constructor(opts: StatusLineOptions = {}) {
    this.stream = opts.stream ?? process.stdout;
    this.onInterrupt = opts.onInterrupt;
    this.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
  }

  /** Begin the animation. Call once per agent turn. */
  start(): void {
    this.startedAt = Date.now();
    this.tokens = 0;
    this.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    this.attachEscListener();

    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, TICK_MS);

    this.render();
  }

  /** Call this as tokens stream in from the model. */
  addTokens(n: number): void {
    this.tokens += n;
  }

  /** Stop the animation and clear (or finalize) the line. */
  stop(finalMessage?: string): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.detachEscListener();
    this.clearLine();
    if (finalMessage) {
      this.stream.write(finalMessage + "\n");
    }
  }

  // ---- internals -----------------------------------------------------

  private render(): void {
    const elapsedSec = Math.floor((Date.now() - this.startedAt) / 1000);
    const tokenLabel = this.tokens >= 1000
      ? `${(this.tokens / 1000).toFixed(1)}k`
      : `${this.tokens}`;

    const line =
      `${SPINNER_FRAMES[this.frame]} ${this.verb}… ` +
      `(${elapsedSec}s · ↑ ${tokenLabel} tokens · esc to interrupt)`;

    this.clearLine();
    this.stream.write(line);
    this.lastLineLength = line.length;
  }

  private clearLine(): void {
    // \r returns cursor to column 0; \x1b[K clears from cursor to end of line.
    this.stream.write("\r\x1b[K");
  }

  private attachEscListener(): void {
    if (!process.stdin.isTTY) return;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    this.keypressHandler = (_str, key) => {
      if (key?.name === "escape") {
        this.onInterrupt?.();
      }
      // Preserve normal Ctrl+C behavior.
      if (key?.ctrl && key?.name === "c") {
        this.stop();
        process.exit(130);
      }
    };
    process.stdin.on("keypress", this.keypressHandler);
  }

  private detachEscListener(): void {
    if (this.keypressHandler) {
      process.stdin.off("keypress", this.keypressHandler);
      this.keypressHandler = null;
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }
}
