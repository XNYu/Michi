/**
 * AsyncGate — a simple open/closed gate for coordinating the idle pump with send().
 *
 * When closed, `await gate.wait()` blocks until someone calls `gate.open()`.
 * When open, `await gate.wait()` resolves immediately.
 */
export class AsyncGate {
  private resolve: (() => void) | null = null;
  private promise: Promise<void> | null = null;
  private _open = true;

  get isOpen(): boolean {
    return this._open;
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.promise = new Promise<void>((r) => {
      this.resolve = r;
    });
  }

  open(): void {
    if (this._open) return;
    this._open = true;
    const r = this.resolve;
    this.resolve = null;
    this.promise = null;
    r?.();
  }

  async wait(): Promise<void> {
    // Must loop: the gate may be re-closed between the resolve of the old
    // promise and this continuation actually running (microtask ordering).
    while (!this._open) {
      await this.promise;
    }
  }
}
