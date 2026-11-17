const locks = new WeakMap();
const key = (projectId, planId) => JSON.stringify([projectId, planId]);
export function assertMCPPlanIdle(store, projectId, planId) {
  if (locks.get(store)?.has(key(projectId, planId)))
    throw Error("执行中的计划不能修改、删除或重复执行");
}
export function lockMCPPlan(store, projectId, planId) {
  assertMCPPlanIdle(store, projectId, planId);
  let set = locks.get(store);
  if (!set) {
    set = new Set();
    locks.set(store, set);
  }
  const id = key(projectId, planId);
  set.add(id);
  return () => set.delete(id);
}
