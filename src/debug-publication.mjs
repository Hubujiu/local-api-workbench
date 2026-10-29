// Process-local clear epochs; never serialized into projects or responses.
// Cache entry identity handles edits/publications without per-environment tombstones.
const epochs = new WeakMap();
export function captureDebugPublication(cache, projectId, cacheKey) {
  return {
    cache,
    projectId,
    cacheKey,
    epoch: epochs.get(cache)?.get(projectId),
    entry: cache.get(cacheKey),
  };
}
export function writeDebugVariables(cache, projectId, cacheKey, entry) {
  // New identity invalidates running publishers even for an identical manual edit.
  cache.set(cacheKey, { ...entry });
}
export function publishDebugVariables(cache, ticket, entry) {
  if (
    ticket.cache !== cache ||
    epochs.get(cache)?.get(ticket.projectId) !== ticket.epoch ||
    cache.get(ticket.cacheKey) !== ticket.entry
  )
    return false;
  writeDebugVariables(cache, ticket.projectId, ticket.cacheKey, entry);
  return true;
}
export function clearDebugVariables(cache, projectId) {
  let projects = epochs.get(cache);
  if (!projects) epochs.set(cache, (projects = new Map()));
  // Invalidate absent-entry publishers too (undefined -> undefined ABA).
  projects.set(projectId, Symbol());
  for (const key of cache.keys())
    if (key.startsWith(projectId + ":")) cache.delete(key);
}
