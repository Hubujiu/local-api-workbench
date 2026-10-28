import assert from "node:assert/strict";

// Keep the owner failure body diagnostic without reading successful archives twice.
export async function readArchiveOwnerResponse(response) {
  if (!response.ok) assert(response.ok, await response.clone().text());
  return response.json();
}
