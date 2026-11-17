// Shared project mutation/execution ownership; one pending write and reconciliation gate.
// Client ownership only. The server still owns validation, persistence and revisions.
export function createProjectImportGuard() {
  let pending = null,
    generation = 0,
    ownSave = false,
    restoreUncertain = false,
    generationLabel = "导入";
  const needsReload = new Map();
  const reload = (id) =>
    `请重新加载原项目核对${needsReload.get(id) || "导入"}结果；当前草稿仍保留，请先复制需要保留的修改。`;
  function assertCanStart(id, mode) {
    if (pending) throw Error(`${pending.label}尚未完成，请等待`);
    if (needsReload.has(id)) throw Error(reload(id));
    if (mode === "restore" && restoreUncertain)
      throw Error("恢复结果尚未核对，请刷新页面检查项目列表，避免重复创建副本");
  }
  function assertReloadCurrent(checkpoint) {
    if (pending || checkpoint !== generation)
      throw Error(`加载期间${generationLabel}状态已变化，请重新加载核对`);
  }
  return {
    assertCanStart,
    assertCanSave(id) {
      if (needsReload.has(id)) throw Error(reload(id));
      if (pending && (pending.id !== id || !ownSave))
        throw Error(`${pending.label}尚未完成，请等待后保存`);
    },
    beginSave(id) {
      this.assertCanSave(id);
      if (pending && ownSave && pending.id === id) {
        return {
          requireReconciliation() {
            needsReload.set(id, "保存");
          },
          finish() {},
        };
      }
      return this.begin(id, "save");
    },
    reloadCheckpoint() {
      if (pending) throw Error(`${pending.label}尚未完成，请等待后重新加载`);
      return generation;
    },
    assertReloadCurrent,
    acknowledgeReload(id, checkpoint) {
      assertReloadCurrent(checkpoint);
      needsReload.delete(id);
    },
    // Recovery may stop an existing session after an unknown result, but cannot
    // run concurrently with another project mutation or clear uncertainty.
    beginRecovery(id) {
      return this.begin(id, "execution", true);
    },
    begin(id, mode, recovery = false) {
      if (recovery) {
        if (pending) throw Error(`${pending.label}尚未完成，请等待`);
      } else assertCanStart(id, mode);
      const label =
        { save: "保存", case: "用例保存", plan: "计划保存", execution: "执行" }[
          mode
        ] || "导入";
      const operation = { id, label };
      generationLabel = label;
      pending = operation;
      generation++;
      return {
        async saveDraft(save) {
          ownSave = true;
          try {
            await save();
          } finally {
            ownSave = false;
          }
        },
        requireReconciliation() {
          if (mode === "restore") restoreUncertain = true;
          else needsReload.set(id, label);
        },
        finish() {
          if (pending === operation) {
            pending = null;
            ownSave = false;
          }
        },
      };
    },
  };
}
