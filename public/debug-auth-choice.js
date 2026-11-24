import { authTypes } from "./auth-model.js";

const requestedOrder = [
  "inherit",
  "none",
  "apiKey",
  "basic",
  "bearer",
  "jwt",
  "digest",
  "oauth1",
  "oauth2",
  "hawk",
  "aws",
  "ntlm",
  "edgegrid",
  "asap",
];
export const debugAuthChoices = Object.freeze([
  ...requestedOrder.filter(
    (type) => type === "inherit" || authTypes.includes(type),
  ),
  ...authTypes.filter((type) => !requestedOrder.includes(type)),
]);

export function usesDebugAuthChoice(project, request) {
  return !project?.settings?.nativeInheritance && !request?.nativeInheritance;
}

export function debugAuthChoice(request) {
  const type = request.auth?.type || "none";
  if (type !== "none") return type;
  return request.authSnapshot !== true && request.inheritAuth !== false
    ? "inherit"
    : "none";
}

// Only the chosen configuration is executable and serialized. Each request's
// inactive method drafts are separate, in-memory entries owned by the editor.
export function updateDebugAuthChoice(request, choice, drafts) {
  if (!debugAuthChoices.includes(choice)) throw Error("请求认证类型不受支持");
  if (choice === "inherit" && request.authSnapshot === true)
    throw Error("此请求的认证已固定，不能改为继承父级");
  if (debugAuthChoice(request) === choice) return false;
  const before = request.auth?.type || "none";
  const type = choice === "inherit" ? "none" : choice;
  if (before !== type && before !== "none")
    drafts.set(before, structuredClone(request.auth));
  if (type === "none") {
    // A deliberate policy change must never revive stale fields from a legacy
    // none record. An untouched record is not rewritten just by viewing it.
    request.auth = { type: "none" };
    request.inheritAuth = choice === "inherit";
  } else {
    request.auth = structuredClone(drafts.get(type) || { type });
    request.auth.type = type;
  }
  return true;
}

export function captureDebugAuthOperation(project, request) {
  const config = request.auth;
  const fingerprint = (r) =>
    JSON.stringify([r.auth, r.inheritAuth, r.authSnapshot]);
  const original = fingerprint(request);
  return (owner, candidate) =>
    owner === project &&
    candidate === request &&
    candidate.auth === config &&
    usesDebugAuthChoice(owner, candidate) &&
    fingerprint(candidate) === original;
}
