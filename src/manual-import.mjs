import { createManualImportTokens } from "./manual-import-token.mjs";
import {
  normalizeManualImportInput,
  normalizeManualImportApply,
  assertManualImportResult,
} from "./manual-import-input.mjs";
import { prepareManualImportSource } from "./manual-import-source.mjs";
import { buildManualImportPlan } from "./manual-import-planner.mjs";
import { projectFingerprint } from "./project-files.mjs";

// One ephemeral signing domain per host process. Tokens are neither encrypted
// source storage nor grants; live permissions and cancellation remain host-owned.
const tokens = createManualImportTokens();
export function manualImportError(error) {
  if (
    ["PROJECT_COMMIT_UNCERTAIN", "PROJECT_RECOVERY_REQUIRED"].includes(
      error?.code,
    )
  )
    return error;
  const code =
    typeof error?.code === "string" &&
    /^MANUAL_IMPORT_[A-Z_]{1,64}$/.test(error.code)
      ? error.code
      : error?.code === "STORE_SAVE_ABORTED" || error?.name === "AbortError"
        ? "MANUAL_IMPORT_ABORTED"
        : "MANUAL_IMPORT_INVALID";
  return Object.assign(
    Error("手动导入未完成；请检查选择、权限与冲突后重新预览"),
    { code },
  );
}
const active = (signal) => signal?.throwIfAborted();
function binding(project, input, sessionId) {
  const { document, ...options } = input;
  return {
    projectId: project.id,
    sessionId,
    configRevision: project.configRevision ?? project.revision ?? 0,
    // Trusted persisted configuration may exceed the bounded source-document
    // budget. Its existing fingerprint is privately committed, never exposed.
    configurationDigest: tokens.commit(
      projectFingerprint(project),
      "configuration",
    ),
    sourceDigest: tokens.commit(document, "source"),
    optionsDigest: tokens.commit({ contract: 1, ...options }, "options"),
  };
}
async function plan(project, input, context, signal) {
  active(signal);
  const source = await prepareManualImportSource(
    { format: input.format, document: input.document, options: input.options },
    context,
  );
  active(signal);
  return buildManualImportPlan(project, source, input, context);
}
export async function previewManualImport(
  project,
  raw,
  { sessionId, signal, validate } = {},
) {
  try {
    active(signal);
    const input = normalizeManualImportInput(raw);
    const bound = binding(project, input, sessionId);
    const context = tokens.createContext();
    const result = await plan(project, input, context, signal);
    let impact;
    if (!result.blockers.length && !result.noOp) {
      try {
        impact = validate(result.project, context);
      } catch {
        result.blockers.push({
          key: "project",
          code: "candidate_validation_or_capacity",
        });
      }
    }
    const planDigest = tokens.commit(result.evidence, "plan");
    const output = {
      version: 1,
      configRevision: bound.configRevision,
      sourceDigest: bound.sourceDigest,
      optionsDigest: bound.optionsDigest,
      planDigest,
      expiresAt: context.expiresAt,
      items: result.items,
      warnings: result.warnings,
      blockers: result.blockers,
      counts: result.counts,
      noOp: result.noOp,
      ...(impact ? { historyImpact: impact } : {}),
      ...(!result.blockers.length
        ? { token: tokens.sign(context, { ...bound, planDigest }) }
        : {}),
    };
    active(signal);
    assertManualImportResult(output);
    return output;
  } catch (error) {
    throw manualImportError(error);
  }
}

// This function must run under the Store's project lock, against the latest
// recovered project. authenticate never authorizes commit: final verify below
// binds the rebuilt plan and is repeated at journal publication.
export async function materializeManualImport(
  project,
  raw,
  { sessionId, signal } = {},
) {
  try {
    active(signal);
    const { token, input } = normalizeManualImportApply(raw);
    const bound = binding(project, input, sessionId);
    const { context } = tokens.authenticate(token, bound);
    const result = await plan(project, input, context, signal);
    if (result.blockers.length)
      throw Object.assign(Error(), { code: "MANUAL_IMPORT_CONFLICT" });
    const full = {
      ...bound,
      planDigest: tokens.commit(result.evidence, "plan"),
    };
    const beforePublish = () => {
      active(signal);
      tokens.verify(token, full);
    };
    beforePublish();
    return { ...result, beforePublish };
  } catch (error) {
    throw manualImportError(error);
  }
}

export function manualImportReceipt(project, result) {
  return {
    configRevision: project.configRevision ?? project.revision ?? 0,
    revision: project.revision ?? 0,
    counts: result.counts,
    noOp: result.noOp,
  };
}
