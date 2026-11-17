import assert from "node:assert/strict";
import { isProxy } from "node:util/types";
import { cliResultMetadata } from "./cli-result-diagnostics.mjs";
import { workerFailureMetadata } from "./worker-rejection-diagnostics.mjs";

// Observe both branches immediately. These callbacks only store and return a
// tagged outcome, so waiting for the handshake cannot leave a rejection orphaned.
export function observeToolCall(pending) {
  const observation = { terminal: undefined };
  observation.completion = pending.then(
    (value) => (observation.terminal = { kind: "fulfilled", value }),
    (reason) => (observation.terminal = { kind: "rejected", reason }),
  );
  observation.assertPending = () => {
    if (observation.terminal !== undefined)
      assert.fail("MCP tool call terminated before fixture abort");
  };
  return observation;
}

const prefix = "MCP_CANCELLATION_METADATA ";
const maxInputBytes = 2 * 1024 * 1024;
const statuses = new Set(["passed", "failed", "cancelled", "skipped"]);
function ownData(object, key) {
  if (!object || typeof object !== "object" || isProxy(object)) return;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}
function contentText(value) {
  const content = ownData(value, "content");
  if (!content || isProxy(content) || !Array.isArray(content)) return;
  const block = ownData(content, "0");
  if (ownData(block, "type") !== "text") return;
  const text = ownData(block, "text");
  return typeof text === "string" ? text : undefined;
}
function nativeStatus(text) {
  if (
    typeof text !== "string" ||
    text.length > maxInputBytes ||
    Buffer.byteLength(text) > maxInputBytes
  )
    return "unknown";
  try {
    const status = ownData(JSON.parse(text), "status");
    return statuses.has(status) ? status : "unknown";
  } catch {
    return "unknown";
  }
}

// Diagnostics never serialize the MCP envelope or thrown value. Native summaries
// do not contain script diagnostics; report only their fixed outcome fields and
// do not reread storage or fabricate canonical run/results evidence.
export function toolCallFailureDiagnostic(name, terminal) {
  const metadata = Object.create(null);
  const kind = ownData(terminal, "kind");
  metadata.terminalKind = ["fulfilled", "rejected"].includes(kind)
    ? kind
    : "pending";
  const native =
    name === "apipost_execute_api" || name === "apipost_execute_flow";
  if (kind === "fulfilled") {
    const value = ownData(terminal, "value");
    const isError = ownData(value, "isError");
    if (typeof isError === "boolean") metadata.isError = isError;
    const text = contentText(value);
    if (native) metadata.status = nativeStatus(text);
    else metadata.result = cliResultMetadata(text);
  } else if (kind === "rejected" && !native) {
    metadata.rejection = workerFailureMetadata(ownData(terminal, "reason"));
  }
  const diagnostic = prefix + JSON.stringify(metadata);
  return Buffer.byteLength(diagnostic) <= 4096
    ? diagnostic
    : prefix + '{"input":"metadata-too-large"}';
}
