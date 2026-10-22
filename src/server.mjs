import { DatabaseSessions } from "./database-sessions.mjs";
import { OAuth1Manager } from "./oauth1-flow.mjs";
import { applySharedAuth } from "./shared-auth.mjs";
import { applyGlobalParameters } from "./global-parameters.mjs";
import { projectCookieSession } from "./cookie-jar.mjs";
import { runLoad } from "./load-runner.mjs";
import { readMCPActivities } from "./mcp-activity.mjs";
import {
  resolveDynamicValue,
  resolveDynamicRequest,
} from "./dynamic-values.mjs";
import { previewFunction } from "./custom-functions.mjs";
import { parseErrorCodeList } from "./error-codes.mjs";
import { sampleProjectSchema, schemaMockResponse } from "./mock-fields.mjs";
import { scopedExecution, scopeMap } from "./variable-scopes.mjs";
import {
  parseParameterImport,
  previewParameterImport,
} from "./parameter-dictionary.mjs";
import { loadMCPConfig, saveMCPConfig } from "./mcp-config-store.mjs";
import { selectMockResponse } from "./mock.mjs";
import { snapshotCase } from "./cases.mjs";
import { versionPlan } from "./plan-version.mjs";
import {
  environmentVariables,
  selectedEnvironment,
  resolveServiceRequest,
  freezeServiceBinding,
  debugEnvironment,
  manageEnvironment,
} from "./environments.mjs";
import { createMCP } from "./mcp.mjs";
import { OAuthManager, exchangeOAuthToken } from "./oauth.mjs";
import { ProtocolSessions } from "./protocol-sessions.mjs";
import { queryRemoteDatabase } from "./remote-database.mjs";
import { mutatePostgres } from "./postgres-write.mjs";
import { mutateRedis } from "./redis.mjs";
import { captureSSE, exchangeTCP, exchangeWebSocket } from "./protocols.mjs";
import { querySQLiteBounded, mutateSQLiteBounded } from "./database.mjs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { Store, executeRequest } from "./runtime.mjs";
import {
  id,
  normalizeRequest,
  interpolate,
  importDocument,
  importIntoProject,
  exportOpenAPI,
  snapshotPlan,
  runPlan,
  toCurl,
  restoreProject,
} from "./core.mjs";
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
export async function createApp({
  root = process.env.LOCAL_API_DATA || ".local-api",
  port = Number(process.env.PORT) || 4318,
} = {}) {
  const requestedPort = port;
  const store = new Store(path.resolve(root));
  await store.init();
  const protocolSessions = new ProtocolSessions();
  const oauth = new OAuthManager();
  const oauth1 = new OAuth1Manager();
  const databaseSessions = new DatabaseSessions();
  const debugEnvironments = new Map();
  const mcpActivities = new Map();
  let mcp = { enabled: false, projects: [], write: false, execute: false },
    mcpToken = "",
    mcpLastActivity = null;
  const persistedMCP = await loadMCPConfig(path.resolve(root));
  let mcpWarning = persistedMCP?.warning || "";
  if (persistedMCP && !mcpWarning) {
    const {
      token: savedToken,
      port: savedPort,
      ...configuration
    } = persistedMCP;
    mcp = configuration;
    mcpToken = savedToken;
    if (port === 0) port = savedPort;
  }
  const token = randomBytes(32).toString("hex"),
    controllers = new Map();
  let server;
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  async function body(req) {
    let bytes = 0,
      chunks = [];
    for await (const c of req) {
      bytes += c.length;
      if (bytes > 12 * 1024 * 1024) throw Error("输入超过 12 MiB");
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }
  server = http.createServer(async (req, res) => {
    try {
      const base = `http://127.0.0.1:${server.address().port}`,
        host = req.headers.host;
      if (
        ![
          `127.0.0.1:${server.address().port}`,
          `localhost:${server.address().port}`,
        ].includes(host)
      )
        return json(res, 403, { error: "Host rejected" });
      const origin = req.headers.origin;
      if (
        origin &&
        ![base, `http://localhost:${server.address().port}`].includes(origin)
      )
        return json(res, 403, { error: "Origin rejected" });
      const u = new URL(req.url, base),
        parts = u.pathname.split("/").filter(Boolean);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (u.pathname === "/api/session" && req.method === "GET") {
        if (req.headers["x-local-token"] !== token)
          return json(res, 403, {
            error: "请使用启动时生成的本地链接打开工作台",
          });
        return json(res, 200, { token, version: "0.1.0" });
      }
      if (u.pathname === "/oauth/callback" && req.method === "GET") {
        await oauth.complete(Object.fromEntries(u.searchParams));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'",
        });
        return res.end(
          "<!doctype html><meta charset=utf-8><title>授权完成</title><p>授权完成。请回到 Local API 工作台；可以关闭此页。</p>",
        );
      }
      if (u.pathname === "/mcp") {
        if (!mcp.enabled || req.headers.authorization !== "Bearer " + mcpToken)
          return json(res, 403, { error: "MCP disabled or unauthorized" });
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          return json(res, 405, { error: "Only POST is supported" });
        }
        const message = await body(req);
        if (!message || Array.isArray(message) || message.jsonrpc !== "2.0")
          return json(res, 400, { error: "Invalid JSON-RPC request" });
        const activityId = id();
        if (message.method === "tools/call") {
          const active = [...mcpActivities.values()].filter(
            (a) => a.status === "running",
          );
          if (active.length >= 10)
            return json(res, 429, { error: "MCP并发任务达到上限" });
          mcpActivities.set(activityId, {
            id: activityId,
            tool: message.params?.name,
            projectId: message.params?.arguments?.projectId,
            planId: message.params?.arguments?.planId,
            status: "running",
            startedAt: new Date().toISOString(),
            completed: 0,
          });
        }
        const dispatch = createMCP({
          store,
          ...mcp,
          debugEnvironments,
          onProgress: (progress) => {
            const activity = mcpActivities.get(activityId);
            if (activity)
              Object.assign(activity, { ...progress, status: "running" });
          },
        });
        const result = await dispatch(message);
        if (message.method === "tools/call") {
          const activity = mcpActivities.get(activityId);
          Object.assign(activity, {
            status: result?.result?.isError ? "failed" : "completed",
            finishedAt: new Date().toISOString(),
          });
          mcpLastActivity = activity;
          if (
            mcp.remember &&
            message.params?.name === "localapi_create_project" &&
            !result?.result?.isError
          )
            await saveMCPConfig(path.resolve(root), {
              ...mcp,
              token: mcpToken,
              port: server.address().port,
            });
          const completed = [...mcpActivities.values()].filter(
            (a) => a.status !== "running",
          );
          for (const old of completed.slice(
            0,
            Math.max(0, completed.length - 20),
          ))
            mcpActivities.delete(old.id);
        }
        if (result === null) {
          res.writeHead(202);
          return res.end();
        }
        return json(res, 200, result);
      }
      if (parts[0] === "mock") {
        const p = await store.get(parts[1]),
          r = p.requests.find((r) => r.id === parts[2] && !r.deletedAt);
        if (!r) return json(res, 404, { error: "Mock not found" });
        if (p.settings?.mockEnabled === false)
          return json(res, 503, { error: "Mock服务已关闭" });
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) throw Error("Mock请求体超过8MiB");
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        let incoming = raw;
        try {
          incoming = JSON.parse(raw);
        } catch {}
        if (u.searchParams.getAll("example").length > 1)
          throw Error("Mock示例索引不能重复");
        const selected = selectMockResponse(
          r,
          {
            method: req.method,
            query: Object.fromEntries(u.searchParams),
            headers: req.headers,
            body: incoming,
          },
          () => schemaMockResponse(p, r),
        );
        if (selected.delayMs)
          await new Promise((resolve) => setTimeout(resolve, selected.delayMs));
        res.writeHead(selected.status, {
          "Content-Type": "application/json",
          ...selected.headers,
        });
        return res.end(
          [204, 205, 304].includes(selected.status) ? "" : selected.body,
        );
      }
      if (parts[0] === "api") {
        if (req.headers["x-local-token"] !== token)
          return json(res, 403, { error: "Session token required" });
        if (u.pathname === "/api/protocol-sessions" && req.method === "POST")
          return json(res, 200, protocolSessions.start(await body(req)));
        if (parts[1] === "protocol-sessions" && parts[2]) {
          if (req.method === "GET")
            return json(res, 200, protocolSessions.snapshot(parts[2]));
          const data = await body(req);
          if (parts[3] === "send")
            return json(
              res,
              200,
              protocolSessions.send(parts[2], data.message),
            );
          if (parts[3] === "stop") {
            protocolSessions.stop(parts[2]);
            return json(res, 200, protocolSessions.snapshot(parts[2]));
          }
        }
        if (u.pathname === "/api/oauth1/start" && req.method === "POST")
          return json(res, 200, await oauth1.start(await body(req)));
        if (u.pathname === "/api/oauth1/complete" && req.method === "POST")
          return json(res, 200, await oauth1.complete(await body(req)));
        if (u.pathname === "/api/oauth/start" && req.method === "POST")
          return json(res, 200, oauth.start(await body(req), base));
        if (
          parts[1] === "oauth" &&
          parts[2] === "status" &&
          req.method === "GET"
        )
          return json(res, 200, oauth.status(parts[3]));
        if (u.pathname === "/api/oauth/token" && req.method === "POST") {
          const config = await body(req);
          const grant =
            config.grantType === "refresh_token"
              ? {
                  grant_type: "refresh_token",
                  refresh_token: config.refreshToken,
                }
              : { grant_type: "client_credentials" };
          return json(res, 200, await exchangeOAuthToken(config, grant));
        }
        if (u.pathname === "/api/mcp/config") {
          if (req.method === "POST") {
            const config = await body(req);
            if (!Array.isArray(config.projects))
              throw Error("项目授权列表无效");
            const existing = new Set(
              (await store.list()).map((project) => project.id),
            );
            if (config.projects.some((id) => !existing.has(id)))
              throw Error("不能授权不存在的项目");
            const next = {
              enabled: config.enabled === true,
              remember: config.remember === true,
              projects: config.projects,
              write: config.write === true,
              execute: config.write === true && config.execute === true,
            };
            const nextToken = next.enabled
              ? !mcpToken || config.rotate === true
                ? randomBytes(32).toString("hex")
                : mcpToken
              : "";
            await saveMCPConfig(path.resolve(root), {
              ...next,
              token: nextToken,
              port: server.address().port,
            });
            mcp = next;
            mcpToken = nextToken;
            mcpWarning = "";
          } else if (req.method !== "GET")
            return json(res, 405, { error: "Method not allowed" });
          return json(res, 200, {
            ...mcp,
            endpoint: base + "/mcp",
            dataRoot: store.root,
            warning: mcpWarning,
            token: mcpToken,
            lastActivity: mcpLastActivity,
            activities: [
              ...mcpActivities.values(),
              ...(await readMCPActivities(store.root)),
            ],
          });
        }
        if (u.pathname === "/api/projects" && req.method === "GET")
          return json(res, 200, await store.list());
        if (u.pathname === "/api/projects" && req.method === "POST") {
          const b = await body(req);
          return json(res, 201, await store.create(b.name, b.directory));
        }
        if (u.pathname === "/api/restore" && req.method === "POST") {
          const b = await body(req);
          const restored = restoreProject(b.document);
          await store.save(restored);
          return json(res, 201, restored);
        }
        if (u.pathname === "/api/cancel" && req.method === "POST") {
          const b = await body(req);
          controllers.get(b.id)?.abort();
          return json(res, 200, { ok: true });
        }
        if (parts[1] === "projects" && parts[2]) {
          const p = await store.get(parts[2]);
          const action = parts[3];
          if (action === "cookies") {
            const b = req.method === "POST" ? await body(req) : {};
            const jar = projectCookieSession(
              store,
              p,
              b.environmentId || u.searchParams.get("environmentId"),
            );
            if (req.method === "POST") {
              if (b.operation === "configure") await jar.configure(b);
              else if (b.operation === "set")
                await jar.setCookie(b.url, b.cookie, b);
              else if (b.operation === "remove") await jar.remove(b);
              else if (b.operation === "clear") await jar.clear(b);
              else throw Error("未知Cookie操作");
            } else if (req.method !== "GET") throw Error("Cookie方法无效");
            return json(res, 200, await jar.inspect());
          }

          if (action === "error-codes-preview" && req.method === "POST") {
            const data = await body(req);
            return json(res, 200, { codes: parseErrorCodeList(data.source) });
          }
          if (
            action === "debug-variables" &&
            ["GET", "PUT"].includes(req.method)
          ) {
            const data = req.method === "PUT" ? await body(req) : {};
            const context = debugEnvironment(
              p,
              data.environmentId || u.searchParams.get("environmentId"),
              debugEnvironments,
            );
            const runtimeFingerprint = createHash("sha256")
              .update(JSON.stringify(context.variables))
              .digest("hex");
            if (req.method === "PUT") {
              if (data.runtimeFingerprint !== runtimeFingerprint)
                throw Error("运行时变量已变化，请重新读取");
              if (data.fingerprint !== context.fingerprint)
                throw Error("环境变量已变化，请重新读取运行时变量");
              if (!data.variables || Object.keys(data.variables).length > 10000)
                throw Error("运行时变量最多10000项");
              const variables = scopeMap(data.variables);
              debugEnvironments.set(context.cacheKey, {
                fingerprint: context.fingerprint,
                variables,
              });
              return json(res, 200, { ok: true });
            }
            return json(res, 200, {
              environmentId: context.environment.id,
              fingerprint: context.fingerprint,
              runtimeFingerprint,
              variables: context.variables,
            });
          }
          if (action === "clear-session" && req.method === "POST") {
            for (const key of debugEnvironments.keys())
              if (key.startsWith(p.id + ":")) debugEnvironments.delete(key);
            return json(res, 200, { ok: true });
          }
          if (action === "location" && req.method === "GET")
            return json(res, 200, { path: store.file(p.id) });
          if (!action && req.method === "GET") return json(res, 200, p);
          if (!action && req.method === "PUT") {
            const b = await body(req);
            if (b.id !== p.id) throw Error("项目 ID 不匹配");
            if (
              !Array.isArray(b.requests) ||
              !Array.isArray(b.environments) ||
              !Array.isArray(b.plans)
            )
              throw Error("无效项目结构");
            if (
              b.environments.some(
                (environment) =>
                  !environment ||
                  typeof environment.id !== "string" ||
                  !environment.variables ||
                  typeof environment.variables !== "object" ||
                  Array.isArray(environment.variables),
              )
            )
              throw Error("环境变量必须是对象");
            if (!Array.isArray(b.documents) || !Array.isArray(b.dictionary))
              throw Error("文档或数据字典格式无效");
            if (
              b.documents.some(
                (document) =>
                  !document ||
                  typeof document.title !== "string" ||
                  typeof document.content !== "string",
              )
            )
              throw Error("文档格式无效");
            b.requests = b.requests.map(normalizeRequest);
            b.plans = b.plans.map((plan) =>
              versionPlan(
                p.plans.find((old) => old.id === plan.id),
                plan,
                "manual",
                b,
              ),
            );
            if (b.archived)
              mcp.projects = mcp.projects.filter((id) => id !== b.id);
            b.runs = p.runs;
            b.history = p.history;
            const saved = await store.save(b);
            if (b.archived && mcp.remember)
              await saveMCPConfig(path.resolve(root), {
                ...mcp,
                token: mcpToken,
                port: server.address().port,
              });
            return json(res, 200, saved);
          }
          if (action === "import" && req.method === "POST") {
            const b = await body(req);
            importIntoProject(p, b.document);
            await store.save(p);
            return json(res, 200, p);
          }
          if (action === "export" && req.method === "GET")
            return json(
              res,
              200,
              u.searchParams.get("format") === "openapi" ? exportOpenAPI(p) : p,
            );
          if (action === "protocol" && req.method === "POST") {
            const b = await body(req);
            const fn = {
              sse: captureSSE,
              tcp: exchangeTCP,
              websocket: exchangeWebSocket,
            }[b.type];
            if (!fn) throw Error("未知协议");
            const controller = new AbortController();
            controllers.set(b.runId, controller);
            try {
              return json(res, 200, await fn(b, controller.signal));
            } finally {
              controllers.delete(b.runId);
            }
          }
          if (action === "database-connections") {
            if (req.method === "GET")
              return json(res, 200, databaseSessions.list(p.id));
            if (req.method === "POST")
              return json(
                res,
                200,
                databaseSessions.register(p.id, await body(req)),
              );
            if (req.method === "DELETE") {
              databaseSessions.revoke(p.id, (await body(req)).id);
              return json(res, 200, { revoked: true });
            }
          }
          if (action === "database" && req.method === "POST") {
            const b = await body(req);
            if (b.allowWrite !== undefined && typeof b.allowWrite !== "boolean")
              throw Error("写入标识必须为布尔值");
            if (b.allowWrite === true) {
              if (b.type === "postgres")
                return json(res, 200, await mutatePostgres(b));
              if (b.type === "redis")
                return json(res, 200, await mutateRedis(b));
              if (b.type && b.type !== "sqlite")
                throw Error(
                  "显式写入目前仅支持 SQLite / PostgreSQL / Redis SET",
                );
              return json(
                res,
                200,
                await mutateSQLiteBounded(
                  b.filename,
                  b.sql,
                  b.parameters || [],
                ),
              );
            }

            return json(
              res,
              200,
              b.type && b.type !== "sqlite"
                ? await queryRemoteDatabase(b)
                : await querySQLiteBounded(
                    b.filename,
                    b.sql,
                    b.parameters || [],
                  ),
            );
          }
          if (action === "dictionary-preview" && req.method === "POST") {
            const data = await body(req);
            return json(
              res,
              200,
              previewParameterImport(
                parseParameterImport(data.source, data.format),
                p.parameterDictionary || [],
              ),
            );
          }
          if (action === "sample" && req.method === "POST") {
            const b = await body(req);
            return json(res, 200, {
              sample: sampleProjectSchema(p, b.schema ?? {}),
            });
          }
          if (action === "environments" && req.method === "POST") {
            const b = await body(req);
            const allowedOperations = [
              "list_environments",
              "switch_environment",
              "create_environment",
              "update_environment",
              "delete_environment",
              "list_environment_servers",
              "create_environment_server",
              "update_environment_server",
              "delete_environment_server",
              "get_environment_variables",
              "upsert_environment_variable",
              "delete_environment_variable",
              "get_global_variables",
              "upsert_global_variable",
              "delete_global_variable",
            ];
            if (!allowedOperations.includes(b.operation))
              throw Error("环境操作不存在");
            const result = manageEnvironment(p, b.operation, b.arguments || {});
            if (
              !b.operation.startsWith("list_") &&
              !b.operation.startsWith("get_")
            )
              await store.save(p);
            return json(res, 200, { result, project: p });
          }
          if (action === "dynamic-preview" && req.method === "POST") {
            const b = await body(req);
            const context = debugEnvironment(
              p,
              b.environmentId,
              debugEnvironments,
            );
            return json(res, 200, {
              value: await resolveDynamicValue(
                b.spec,
                context.variables,
                b.functions || p.settings?.functions || [],
              ),
            });
          }
          if (action === "function-preview" && req.method === "POST") {
            const b = await body(req);
            return json(res, 200, await previewFunction(b.function, b.value));
          }
          if (action === "curl" && req.method === "POST") {
            const data = await body(req),
              context = debugEnvironment(
                p,
                data.environmentId,
                debugEnvironments,
              );
            return json(res, 200, {
              curl: toCurl(
                resolveServiceRequest(
                  p,
                  await resolveDynamicRequest(
                    applySharedAuth(p, applyGlobalParameters(p, data.request)),
                    context.variables,
                    p.settings?.functions || [],
                    interpolate,
                  ),
                  context.environment.id,
                ),
              ),
            });
          }
          if (action === "execute" && req.method === "POST") {
            const b = await body(req),
              controller = new AbortController(),
              runId = b.runId || id();
            controllers.set(runId, controller);
            try {
              const context = debugEnvironment(
                p,
                b.environmentId,
                debugEnvironments,
              );
              const environmentKey = context.cacheKey,
                env = context.variables;
              const request = normalizeRequest(
                freezeServiceBinding(p, b.request),
              );
              const scoped = scopedExecution(
                store,
                p,
                context.environment.id,
                env,
              );
              const single = await runPlan(
                snapshotPlan({
                  name: request.name,
                  functions: b.functions || p.settings?.functions || [],
                  steps: [{ request }],
                }),
                env,
                executeRequest,
                {
                  ...scoped,
                  databaseQuery: (operation, signal) =>
                    databaseSessions.query(p.id, operation, signal),
                  cookieSession: projectCookieSession(
                    store,
                    p,
                    context.environment.id,
                  ),
                  signal: controller.signal,
                  prepareRequest: (request) =>
                    resolveServiceRequest(p, request, context.environment.id),
                },
              );
              const result = single.results[0];
              if (result?.response)
                debugEnvironments.set(environmentKey, {
                  fingerprint: JSON.stringify(
                    environmentVariables(p, context.environment.id),
                  ),
                  variables: structuredClone(single.variables),
                });
              if (!result) throw Error("请求已取消");
              await store.append(p.id, "history", {
                id: id(),
                createdAt: new Date().toISOString(),
                name: request.name,
                ...result,
                source: "manual",
                durationMs: single.durationMs,
              });
              return json(res, 200, {
                ...result.response,
                outcome: result.status,
                variableWrites: scoped.receipt(),
                assertions: result.assertions,
                extracted: { ...single.variables, ...result.extracted },
                logs: result.logs,
                subrequests: result.subrequests,
                visualization: result.visualization,
                error: result.error,
              });
            } finally {
              controllers.delete(runId);
            }
          }
          if (action === "cases" && req.method === "POST") {
            const data = await body(req);
            if (
              !p.requests.some(
                (request) =>
                  request.id === data.sourceRequestId && !request.deletedAt,
              )
            )
              throw Error("来源接口不存在");
            const item = snapshotCase({
              ...data,
              request: freezeServiceBinding(p, data.request),
              functions: data.functions || p.settings?.functions || [],
            });
            p.cases ??= [];
            const index = p.cases.findIndex(
              (existing) => existing.id === item.id,
            );
            if (index < 0) {
              if (p.cases.length >= 1000) throw Error("用例最多1000个");
              p.cases.push(item);
            } else p.cases[index] = item;
            await store.save(p);
            return json(res, 200, { item, project: p });
          }
          if (action === "plans" && req.method === "POST") {
            const b = await body(req);
            if (
              (b.projectConfigRevision ?? b.projectRevision) !== undefined &&
              (b.projectConfigRevision ?? b.projectRevision) !==
                (p.configRevision ?? p.revision)
            )
              throw Error("项目已有其他修改，请重新加载");
            const plan = versionPlan(
              p.plans.find((item) => item.id === b.id),
              { ...b, functions: b.functions || p.settings?.functions || [] },
              "manual",
              p,
            );
            const index = p.plans.findIndex((x) => x.id === plan.id);
            if (index < 0) p.plans.push(plan);
            else p.plans[index] = plan;
            await store.save(p);
            return json(res, 200, {
              ...plan,
              projectRevision: p.revision,
              projectConfigRevision: p.configRevision,
              projectFingerprint: p._diskFingerprint,
            });
          }
          if (action === "run" && req.method === "POST") {
            const b = await body(req),
              plan = p.plans.find((x) => x.id === b.planId);
            if (!plan) throw Error("计划不存在");
            const controller = new AbortController();
            controllers.set(b.runId, controller);
            try {
              const environmentId = b.environmentId || plan.environmentId;
              const env = environmentVariables(p, environmentId);
              const run = await runPlan(plan, env, executeRequest, {
                ...scopedExecution(store, p, environmentId),
                databaseQuery: (operation, signal) =>
                  databaseSessions.query(p.id, operation, signal),
                cookieSession: projectCookieSession(store, p, environmentId),
                signal: controller.signal,
                prepareRequest: (request) =>
                  resolveServiceRequest(p, request, environmentId),
              });
              await store.append(p.id, "runs", { ...run, source: "manual" });
              return json(res, 200, run);
            } finally {
              controllers.delete(b.runId);
            }
          }
          if (action === "load" && req.method === "POST") {
            const b = await body(req),
              controller = new AbortController();
            const context = debugEnvironment(
              p,
              b.environmentId,
              debugEnvironments,
            );
            controllers.set(b.runId, controller);
            try {
              return json(
                res,
                200,
                await runLoad(p, b.request, {
                  cookieState: await projectCookieSession(
                    store,
                    p,
                    context.environment.id,
                  ).inspect(),
                  dataCSV: b.dataCSV,
                  count: b.count,
                  concurrency: b.concurrency,
                  environmentId: context.environment.id,
                  variables: context.variables,
                  signal: controller.signal,
                }),
              );
            } finally {
              controllers.delete(b.runId);
            }
          }
        }
        return json(res, 404, { error: "API not found" });
      }
      const pathname = u.pathname === "/" ? "/index.html" : u.pathname;
      const file = path.resolve(publicDir, "." + pathname);
      if (!file.startsWith(publicDir))
        return json(res, 403, { error: "Path rejected" });
      const data = await readFile(file);
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
      );
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css",
          ".js": "text/javascript",
          ".svg": "image/svg+xml",
        }[path.extname(file)] || "application/octet-stream",
      );
      res.end(data);
    } catch (e) {
      json(res, e.code === "ENOENT" ? 404 : 400, { error: e.message });
    }
  });
  server.on("close", () => {
    protocolSessions.close();
    oauth.close();
    oauth1.close();
    databaseSessions.close();
  });
  const listen = (listenPort) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen(port);
  } catch (error) {
    if (
      error.code !== "EADDRINUSE" ||
      requestedPort !== 0 ||
      !persistedMCP?.remember
    )
      throw error;
    mcp.enabled = false;
    mcpToken = "";
    mcpWarning =
      "保存的本地端口被占用，已改用新端口并关闭MCP。请重新授权并复制连接配置。";
    await listen(0);
    await saveMCPConfig(path.resolve(root), {
      ...mcp,
      token: "",
      port: server.address().port,
    });
  }

  return {
    server,
    store,
    oauthAllowed: (url) => oauth.allowed(url) || oauth1.allowed(url),
    launchUrl: `http://127.0.0.1:${server.address().port}/#token=${token}`,
    token,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  console.log(
    `Local API Workbench: ${app.launchUrl}\nData: ${path.resolve(process.env.LOCAL_API_DATA || ".local-api")}`,
  );
}
