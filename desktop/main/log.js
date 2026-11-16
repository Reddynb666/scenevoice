// The shell's own log: the last 200 lines, kept in memory only and written
// nowhere except into a diagnostic report the user saves. Lines say what the
// shell did (which key or menu item acted, what the speech bus did); they never
// carry a file name or a path.

export const MAX_LINES = 200;
const MAX_LINE_LENGTH = 300;

export class RingLog {
  /**
   * @param {{max?: number, now?: () => Date, echo?: (line: string) => void}} [o]
   *   echo: also called with every line (the developer's terminal, when asked for).
   */
  constructor({ max = MAX_LINES, now = () => new Date(), echo = null } = {}) {
    this.max = max;
    this.now = now;
    this.echo = echo;
    this.entries = [];
  }

  /** Add one line; control characters and line breaks become spaces, long lines are cut. */
  add(line) {
    const text = String(line ?? '')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, MAX_LINE_LENGTH);
    if (!text) return;
    const stamp = this.now().toISOString().slice(11, 23);
    this.entries.push(`${stamp} ${text}`);
    if (this.echo) this.echo(`${stamp} ${text}`);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  lines() {
    return this.entries.slice();
  }
}
