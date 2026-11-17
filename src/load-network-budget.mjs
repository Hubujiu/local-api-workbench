import {
  normalizeRedirect,
  validateRedirectAdmission,
} from "./http-redirect.mjs";
import { scriptStages } from "../public/shared-scripts.js";

const budgets = new WeakSet();
const failures = new WeakSet();
// Only in-process transport capabilities, never request JSON or prepared plans.
export function createLoadNetworkBudget(onExhausted = () => {}) {
  let reservations = 0,
    started = 0,
    redirectHops = 0;
  const budget = {
    reserve() {
      if (reservations >= 100) {
        const error = Error("压测主链网络预算已耗尽");
        failures.add(error);
        onExhausted();
        throw error;
      }
      reservations++;
    },
    start(hop = 0) {
      started++;
      if (hop > 0) redirectHops++;
    },
    snapshot() {
      return { limit: 100, reservations, started, redirectHops };
    },
  };
  budgets.add(budget);
  return Object.freeze(budget);
}
export function loadNetworkBudget(value) {
  if (value === undefined) return undefined;
  if (!budgets.has(value)) throw Error("无效的压测网络预算");
  return value;
}
export function isLoadNetworkBudgetFailure(error) {
  return failures.has(error);
}

// Conservative first slice: no script/operation can add hidden network effects.
export function admitLoadRedirects(requests, logicalMaximum) {
  const redirects = requests.map((r) => normalizeRedirect(r.redirect));
  if (!redirects.some(Boolean)) return false;
  const weight = Math.max(...redirects.map((r) => (r ? r.maxHops + 1 : 1)));
  if (logicalMaximum * weight > 100)
    throw Error("重定向压测最坏主链网络次数不得超过 100，请降低次数或 maxHops");
  for (const r of requests) {
    for (const phase of ["before", "after"])
      if (
        scriptStages(r, phase).length ||
        r[phase]?.length ||
        r.nativeTasks?.[phase]?.length
      )
        throw Error("重定向压测暂不支持脚本或前后置任务");
    const dynamicSpecs = [
      ...["query", "headers", "path", "cookies", "form"].flatMap((group) =>
        (r[group] || [])
          .filter((row) => row.enabled !== false && row.dynamic)
          .map((row) => row.dynamic),
      ),
      ...Object.values(r.bodyDynamic || {}),
    ];
    if (
      dynamicSpecs.some(
        (spec) =>
          !["fixed", "variable"].includes(spec.source) ||
          spec.functions?.length,
      )
    )
      throw Error(
        "重定向压测暂不支持动态函数或 Mock 来源，仅支持无加工链的固定值与变量",
      );
    // Apply the existing redirect auth whitelist to every leaf in a mixed run.
    validateRedirectAdmission(
      { ...r, redirect: true, auth: r.auth || { type: "none" } },
      {},
    );
  }
  return true;
}
