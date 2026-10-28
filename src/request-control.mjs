// Deadlines are absolute monotonic milliseconds (performance.now()), not dates.
const interruptions = new WeakMap();

export function requestTimeout() {
  const error = Error("请求超时（总时限已到）");
  error.name = "TimeoutError";
  error.code = "REQUEST_TIMEOUT";
  interruptions.set(error, "timeout");
  return error;
}

export function throwIfInactive({ signal, deadline } = {}) {
  if (deadline !== undefined && !Number.isFinite(deadline))
    throw TypeError("请求截止时间必须为有限的单调时钟毫秒数");
  if (signal?.aborted) {
    // Do not accept an arbitrary signal.reason as trusted execution metadata.
    const error = Error("请求已取消 (aborted)");
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    interruptions.set(error, "cancelled");
    throw error;
  }
  if (deadline !== undefined && performance.now() >= deadline)
    throw requestTimeout();
}

export function interruptionKind(error) {
  return interruptions.get(error);
}

/** Only for observing a predecessor/delay, never abandon a mutating operation. */
export async function waitForControl(promise, controls = {}) {
  throwIfInactive(controls);
  const { signal, deadline } = controls;
  if (!signal && deadline === undefined) return await promise;
  return await new Promise((resolve, reject) => {
    let timer,
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", check);
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      try {
        throwIfInactive(controls);
      } catch (error) {
        finish(error);
      }
    };
    const arm = () => {
      check();
      if (!settled && deadline !== undefined)
        timer = setTimeout(
          arm,
          Math.min(
            2147483647,
            Math.max(1, Math.ceil(deadline - performance.now())),
          ),
        );
    };
    signal?.addEventListener("abort", check, { once: true });
    arm();
    Promise.resolve(promise).then(
      (value) => {
        check();
        finish(undefined, value);
      },
      (error) => finish(error),
    );
  });
}

export async function delayForControl(milliseconds, controls = {}) {
  throwIfInactive(controls);
  let timer;
  try {
    await waitForControl(
      new Promise((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
      controls,
    );
  } finally {
    clearTimeout(timer);
  }
}
