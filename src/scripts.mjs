import { validateResources } from "./resources.mjs";
import { Worker } from "node:worker_threads";

/** QuickJS has no Node bindings; explicit callback HTTP is brokered by the parent. */
export function runScript(code, input, { signal, cookieSession } = {}) {
  validateResources({ functions: input.functions || [] });
  if (typeof code !== "string" || code.length > 100000)
    throw Error("脚本不能超过 100 KB");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Error("脚本执行已取消"));
      return;
    }
    const worker = new Worker(new URL("./script-worker.mjs", import.meta.url), {
      workerData: { code, input },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
    });
    const controller = new AbortController(),
      networkRequests = [];
    let settled = false,
      total = 0,
      active = 0;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.abort();
      worker.terminate();
      if (error) {
        for (const record of networkRequests)
          if (record.status === "running") {
            record.status = "interrupted";
            record.error = error.message;
          }
        error.networkRequests = structuredClone(networkRequests);
        reject(error);
      } else resolve({ ...result, networkRequests });
    };
    const timer = setTimeout(() => finish(Error("脚本执行超时")), 2000);
    const cancel = () => finish(Error("脚本执行已取消"));
    signal?.addEventListener("abort", cancel, { once: true });
    worker.on("message", async (message) => {
      if (settled) return;
      if (message.kind === "http") {
        if (!input.allowNetwork) {
          finish(Error("此脚本未启用HTTP网络能力"));
          return;
        }
        if (++total > 10 || active >= 4) {
          finish(Error("脚本HTTP最多10次、同时4次"));
          return;
        }
        active++;
        let request, response, error;
        const evidence = { status: "running", request: null };
        networkRequests.push(evidence);
        try {
          const { scriptHTTPRequest } = await import("./script-http.mjs");
          const { executeRequest } = await import("./runtime.mjs");
          if (settled) return;
          const payload = JSON.parse(message.payload);
          request = scriptHTTPRequest(payload.request, payload.variables);
          evidence.request = {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
            form: request.form,
          };
          response = await executeRequest(request, controller.signal, {
            cookieSession,
          });
          response = {
            status: response.status,
            statusText: response.statusText,
            duration: response.duration,
            headers: response.headers,
            body: response.body,
            ...(response.cookieError
              ? { cookieError: response.cookieError }
              : {}),
          };
          if (Buffer.byteLength(JSON.stringify(response)) > 262144) {
            response = undefined;
            throw Error("脚本HTTP响应超过256KiB");
          }
        } catch (e) {
          error = String(e.message).slice(0, 2000);
        } finally {
          active--;
        }
        if (settled) return;
        Object.assign(evidence, {
          status: error ? "failed" : "completed",
          ...(response ? { response } : {}),
          ...(error ? { error } : {}),
        });
        worker.postMessage({ kind: "http", id: message.id, error, response });
      } else if (message.error) finish(Error(message.error));
      else finish(null, message.result);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (exitCode) => {
      if (!settled) finish(Error("脚本执行进程被终止: " + exitCode));
    });
  });
}
