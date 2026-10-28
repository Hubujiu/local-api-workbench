import { interruptionKind } from "./request-control.mjs";

const failures = new WeakMap();

/** Internal transport boundary: retain the exact completed response object. */
export function httpFinalizationFailure(
  response,
  cause,
  phase = "cookie-capture",
) {
  const kind = interruptionKind(cause);
  if (
    !kind ||
    !["cookie-capture", "auth-cookie", "response-finalization"].includes(phase)
  )
    throw TypeError("无效的HTTP完成阶段失败");
  const error = Error(cause.message, { cause });
  const failure = Object.freeze({
    phase,
    code: kind === "cancelled" ? "REQUEST_CANCELLED" : "REQUEST_TIMEOUT",
    retry_safe: false,
  });
  response.failure = failure;
  failures.set(error, Object.freeze({ response, failure }));
  return error;
}

// Never trust error.response or caller-supplied objects with similar fields.
export function readHttpFinalizationFailure(error) {
  return failures.get(error);
}
