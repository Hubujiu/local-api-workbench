// Lifecycle commands for projects imported with inheritanceMode: "preserve".
// The server remains the authority for graph identity and atomic batch changes.
export function nativeRequestLifecycleOperation(project, requestId, restore) {
  const graph = project.settings?.nativeInheritance;
  const request = project.requests.find((item) => item.id === requestId);
  if (!graph || !request?.nativeInheritance)
    throw Error("接口不属于当前原生继承图");
  if (Boolean(request.deletedAt) !== restore)
    throw Error(restore ? "接口尚未回收" : "接口已回收");
  if (restore) {
    const matches = (graph.folderLifecycle?.records || [])
      .filter((entry) => entry.state === "recycled")
      .map((entry) => ({
        entry,
        batch: project.apiResourceTrash?.batches.find(
          (batch) => batch.id === entry.batchId,
        ),
      }))
      .filter(({ batch }) => batch?.requestIds.includes(requestId));
    if (matches.length > 1) throw Error("接口回收批次不明确，请重新加载");
    if (matches.length) {
      const { entry, batch } = matches[0];
      const folder = graph.folders.find(
        (folder) => folder.sourceId === entry.sourceId,
      );
      if (!folder) throw Error("回收目录不存在，请重新加载");
      return {
        operation: { type: "restore-folder", batchId: entry.batchId },
        confirmation: `此接口属于已回收目录“${folder.path}”。恢复整个目录及其中 ${batch.requestIds.length} 个接口？`,
      };
    }
  }
  return {
    operation: {
      type: restore ? "restore-requests" : "recycle-requests",
      requestIds: [requestId],
    },
    confirmation: restore ? null : "将此接口移到回收站？",
  };
}

export function createNativeRequestLifecycle() {
  let pendingProject = null;
  let ownSave = false;
  let generation = 0;
  const needsReload = new Set();
  const reloadMessage =
    "请重新加载此项目核对服务器状态；当前草稿仍保留，请先复制需要保留的修改。";
  function assertCanSave(projectId) {
    if (needsReload.has(projectId)) throw Error(reloadMessage);
    if (pendingProject === projectId && !ownSave)
      throw Error("原生接口回收/恢复尚未完成，请等待");
  }
  function assertReloadCurrent(checkpoint) {
    if (pendingProject !== null || checkpoint !== generation)
      throw Error("加载期间原生接口回收/恢复状态已变化，请重新加载核对");
  }
  return {
    assertCanSave,
    reloadCheckpoint() {
      if (pendingProject !== null)
        throw Error("原生接口回收/恢复尚未完成，请等待后重新加载");
      return generation;
    },
    assertReloadCurrent,
    // Call only after a fresh project GET has completed, not on a render/save.
    acknowledgeReload(projectId, checkpoint) {
      assertReloadCurrent(checkpoint);
      needsReload.delete(projectId);
    },
    async run({
      requestId,
      restore,
      getState,
      collect,
      confirm,
      save,
      post,
      apply,
    }) {
      if (pendingProject !== null)
        throw Error("原生接口回收/恢复尚未完成，请等待");
      let state = getState();
      assertCanSave(state.project.id);
      if (state.busy || state.saving) throw Error("请等待当前请求或保存结束");
      const projectId = state.project.id;
      pendingProject = projectId;
      generation++;
      try {
        collect();
        state = getState();
        const intent = nativeRequestLifecycleOperation(
          state.project,
          requestId,
          restore,
        );
        if (intent.confirmation && !confirm(intent.confirmation)) return false;
        if (state.dirty) {
          if (!confirm("当前有未保存修改，先保存再执行回收/恢复？"))
            return false;
          ownSave = true;
          try {
            await save();
          } finally {
            ownSave = false;
          }
        }
        state = getState();
        if (
          state.project.id !== projectId ||
          state.dirty ||
          state.busy ||
          state.saving
        )
          throw Error("项目或草稿已变化，未执行回收/恢复；请先保存并重新操作");
        const latest = nativeRequestLifecycleOperation(
          state.project,
          requestId,
          restore,
        );
        // Saving must not silently widen the operation the user confirmed.
        if (JSON.stringify(latest) !== JSON.stringify(intent))
          throw Error("回收范围已变化，未执行操作；请重新确认");
        const revision = state.project.configRevision;
        if (!Number.isSafeInteger(revision) || revision < 0)
          throw Error("项目版本无效，请重新加载");
        const version = state.editVersion;
        const sameDraft = () => {
          const now = getState();
          return (
            now.project.id === projectId &&
            !now.dirty &&
            now.editVersion === version &&
            now.project.configRevision === revision
          );
        };
        let result;
        try {
          result = await post(
            "/projects/" + projectId + "/native-inheritance-edit",
            "POST",
            { configRevision: revision, operation: latest.operation },
          );
        } catch (error) {
          // Rejection and a lost response are both reconciled by GET; never
          // automatically replay a possibly committed lifecycle command.
          needsReload.add(projectId);
          throw Error(
            "回收/恢复未确认：" + error.message + "。" + reloadMessage,
          );
        }
        if (!sameDraft() || result?.id !== projectId) {
          needsReload.add(projectId);
          throw Error(
            "服务器已完成回收/恢复，但当前草稿未被替换。" + reloadMessage,
          );
        }
        apply(result);
        return true;
      } finally {
        ownSave = false;
        pendingProject = null;
      }
    },
  };
}
