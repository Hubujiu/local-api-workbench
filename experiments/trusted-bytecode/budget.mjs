import { performance } from "node:perf_hooks";
import { LIMITS } from "./catalog.mjs";

// Clock injection is exclusively for deterministic budget unit tests. Runtime
// callers construct this with no argument; no limit override exists.
export class ActivityBudget {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.used = 0;
    this.depth = 0;
    this.started = 0;
    this.metrics = {};
  }
  elapsed() {
    return this.used + (this.depth ? this.now() - this.started : 0);
  }
  expired() {
    return this.elapsed() >= LIMITS.activeMs;
  }
  check() {
    if (this.expired())
      throw Error("Trusted bytecode active wall-time budget exceeded");
  }
  begin() {
    this.check();
    if (this.depth++ === 0) this.started = this.now();
    return this.now();
  }
  end(label, start) {
    const ended = this.now();
    this.metrics[label] =
      (this.metrics[label] || 0) + Math.max(0, ended - start);
    if (--this.depth === 0) this.used += Math.max(0, ended - this.started);
    this.check(); // A late success is not success, including non-interruptible ReadObject.
  }
  run(label, fn) {
    const start = this.begin();
    try {
      return fn();
    } finally {
      this.end(label, start);
    }
  }
  async runAsync(label, fn) {
    const start = this.begin();
    try {
      return await fn();
    } finally {
      this.end(label, start);
    }
  }
}
