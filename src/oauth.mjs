import { randomBytes, createHash } from "node:crypto";
import { executeRequest } from "./runtime.mjs";

const exchangeTimeout = 15000;
const flowLifetime = 5 * 60 * 1000;
const providerErrors = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "unsupported_response_type",
  "server_error",
  "temporarily_unavailable",
]);
function failure(code, message) {
  return Object.assign(Error(message), { code });
}
function cancelled() {
  return failure("OAUTH_CANCELLED", "OAuth 请求已取消");
}
function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("OAuth endpoint 无效");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error("OAuth endpoint 无效");
  return url;
}
function configuration(config) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    JSON.stringify(config).length > 65536
  )
    throw Error("OAuth 配置无效");
  for (const key of ["clientId", "clientSecret", "scope"])
    if (
      config[key] !== undefined &&
      (typeof config[key] !== "string" || !config[key].isWellFormed())
    )
      throw Error("OAuth 客户端配置须为文本");
  const authentication =
    config.clientAuthentication === undefined ||
    config.clientAuthentication === ""
      ? "body"
      : config.clientAuthentication;
  if (!["basic", "body", "none"].includes(authentication))
    throw Error("OAuth 客户端认证仅支持 basic、body 或 none");
  endpoint(config.tokenEndpoint);
  return authentication;
}
function providerFailure(data, status) {
  // Providers may echo codes or credentials in descriptions: never relay them.
  const code = providerErrors.has(data?.error) ? "（" + data.error + "）" : "";
  return Error(
    "OAuth token exchange failed" + (status ? "，HTTP " + status : "") + code,
  );
}
function tokenResponse(response) {
  if (
    typeof response.body !== "string" ||
    Buffer.byteLength(response.body) > 65536
  )
    throw Error("OAuth token endpoint 响应过大或无效");
  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    throw Error("OAuth token endpoint 返回非 JSON 响应");
  }
  if (response.status < 200 || response.status >= 300 || data?.error)
    throw providerFailure(data, response.status);
  const text = (value) =>
    typeof value === "string" &&
    value.trim() &&
    value.length <= 8192 &&
    !/[\r\n\0]/.test(value);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !text(data.access_token) ||
    (data.token_type !== undefined &&
      (!text(data.token_type) ||
        !/^[A-Za-z][A-Za-z0-9._~-]*$/.test(data.token_type))) ||
    (data.refresh_token !== undefined && !text(data.refresh_token)) ||
    (data.scope !== undefined &&
      (typeof data.scope !== "string" ||
        data.scope.length > 8192 ||
        /[\r\n\0]/.test(data.scope))) ||
    (data.expires_in !== undefined &&
      (!Number.isSafeInteger(data.expires_in) || data.expires_in < 0))
  )
    throw Error("OAuth token endpoint 返回无效令牌字段");
  // The existing oauth2 request executor installs Bearer, not MAC or DPoP.
  // Do not report a usable credential that would be sent under the wrong scheme.
  if (
    data.token_type !== undefined &&
    data.token_type.toLowerCase() !== "bearer"
  )
    throw Error("OAuth token type 仅支持 Bearer");
  return {
    accessToken: data.access_token,
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token,
    scope: data.scope,
  };
}
export async function exchangeOAuthToken(config, extra = {}, signal) {
  if (signal?.aborted) throw cancelled();
  const authentication = configuration(config);
  const fields = { ...extra };
  // The selected mode alone owns client authentication, including supplied extras.
  delete fields.client_id;
  delete fields.client_secret;
  for (const key of ["code", "refresh_token"])
    if (
      fields[key] !== undefined &&
      (typeof fields[key] !== "string" ||
        !fields[key].trim() ||
        !fields[key].isWellFormed() ||
        fields[key].length > 8192 ||
        /[\r\n\0]/.test(fields[key]))
    )
      throw Error("OAuth 授权码或 refresh token 无效");
  if (config.scope) fields.scope = config.scope;
  let auth = { type: "none" };
  if (authentication === "basic") {
    // RFC 6749 §2.3.1: encode each credential before constructing HTTP Basic.
    // This must not change ordinary HTTP Basic in the shared request executor.
    const encode = (value) =>
      new URLSearchParams([["v", value || ""]]).toString().slice(2);
    auth = {
      type: "basic",
      username: encode(config.clientId),
      password: encode(config.clientSecret),
    };
  } else {
    fields.client_id = config.clientId || "";
    if (authentication === "body" && config.clientSecret !== undefined)
      fields.client_secret = config.clientSecret;
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(cancelled());
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(
    () => controller.abort(failure("OAUTH_TIMEOUT", "OAuth token 请求超时")),
    exchangeTimeout,
  );
  timer.unref?.();
  try {
    controller.signal.throwIfAborted();
    const response = await executeRequest(
      {
        method: "POST",
        url: config.tokenEndpoint,
        auth,
        bodyType: "urlencoded",
        form: Object.entries(fields)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => ({ key, value, enabled: true })),
        timeout: exchangeTimeout,
      },
      controller.signal,
    );
    controller.signal.throwIfAborted();
    return tokenResponse(response);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    // The HTTP executor also enforces the same total deadline.
    if (/超时/.test(error.message))
      throw failure("OAUTH_TIMEOUT", "OAuth token 请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
export class OAuthManager {
  constructor() {
    this.flows = new Map();
    this.exchanges = new Set();
    this.closed = false;
  }
  assertOpen() {
    if (this.closed) throw failure("OAUTH_CLOSED", "OAuth 流程已关闭");
  }
  forget(id, reason) {
    const flow = this.flows.get(id);
    if (!flow) return;
    flow.controller.abort(reason);
    clearTimeout(flow.timer);
    this.flows.delete(id);
    delete flow.config;
    delete flow.verifier;
    delete flow.state;
    delete flow.result;
  }
  prune() {
    for (const [id, flow] of this.flows)
      if (flow.expiresAt <= Date.now())
        this.forget(id, failure("OAUTH_EXPIRED", "OAuth 流程已过期"));
  }
  active(flow) {
    this.assertOpen();
    this.prune();
    flow.controller.signal.throwIfAborted();
    if (this.flows.get(flow.id) !== flow)
      throw failure("OAUTH_EXPIRED", "OAuth 流程已过期");
  }
  async exchange(config, extra, signal) {
    this.assertOpen();
    if (signal?.aborted) throw cancelled();
    if (this.exchanges.size >= 10)
      throw Error("OAuth 令牌请求过多，请稍后重试");
    const controller = new AbortController();
    const onAbort = () => controller.abort(cancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    this.exchanges.add(controller);
    try {
      const result = await exchangeOAuthToken(config, extra, controller.signal);
      this.assertOpen();
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.exchanges.delete(controller);
    }
  }
  start(config, baseURL) {
    this.assertOpen();
    this.prune();
    if (this.flows.size >= 10) throw Error("OAuth 流程过多，请稍后重试");
    configuration(config);
    const authorization = endpoint(config.authorizationEndpoint);
    const id = randomBytes(16).toString("hex"),
      state = randomBytes(24).toString("hex"),
      verifier = randomBytes(48).toString("base64url");
    const redirectUri = baseURL + "/oauth/callback";
    const params = {
      response_type: "code",
      client_id: config.clientId || "",
      redirect_uri: redirectUri,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    };
    if (config.scope) params.scope = config.scope;
    for (const [key, value] of Object.entries(params))
      authorization.searchParams.set(key, value);
    const flow = {
      id,
      state,
      verifier,
      redirectUri,
      authorizationUrl: authorization.href,
      config: structuredClone(config),
      controller: new AbortController(),
      status: "pending",
      expiresAt: Date.now() + flowLifetime,
    };
    flow.timer = setTimeout(
      () => this.forget(id, failure("OAUTH_EXPIRED", "OAuth 流程已过期")),
      flowLifetime,
    );
    flow.timer.unref?.();
    this.flows.set(id, flow);
    return { id, authorizationUrl: authorization.href, redirectUri };
  }
  allowed(url) {
    this.prune();
    return (
      !this.closed &&
      [...this.flows.values()].some(
        (flow) => flow.status === "pending" && flow.authorizationUrl === url,
      )
    );
  }
  status(id) {
    this.prune();
    const flow = this.flows.get(id);
    if (!flow) throw Error("OAuth 流程已过期");
    return structuredClone({
      status: flow.status,
      result: flow.result,
      error: flow.error,
      errorCode: flow.errorCode,
    });
  }
  async complete(params = {}, signal) {
    this.assertOpen();
    this.prune();
    const flow =
      typeof params.state === "string" &&
      [...this.flows.values()].find((flow) => flow.state === params.state);
    if (!flow || flow.status !== "pending")
      throw Error("OAuth state 无效、过期或已使用");
    // Claim synchronously before awaiting: errors and cancellation consume state too.
    flow.status = "exchanging";
    try {
      this.active(flow);
      if (signal?.aborted) throw cancelled();
      if (params.error) throw providerFailure(params);
      if (
        typeof params.code !== "string" ||
        !params.code.trim() ||
        !params.code.isWellFormed() ||
        params.code.length > 8192 ||
        /[\r\n\0]/.test(params.code)
      )
        throw Error("回调缺少有效授权码");
      const result = await this.exchange(
        flow.config,
        {
          grant_type: "authorization_code",
          code: params.code,
          redirect_uri: flow.redirectUri,
          code_verifier: flow.verifier,
        },
        signal
          ? AbortSignal.any([flow.controller.signal, signal])
          : flow.controller.signal,
      );
      this.active(flow);
      if (signal?.aborted) throw cancelled();
      flow.result = result;
      flow.status = "completed";
      return { ok: true };
    } catch (error) {
      if (flow.controller.signal.aborted) error = flow.controller.signal.reason;
      if (!this.closed && this.flows.get(flow.id) === flow) {
        flow.status = "error";
        flow.error = error.message;
        flow.errorCode = error.code;
      }
      throw error;
    } finally {
      delete flow.config;
      delete flow.verifier;
      delete flow.state;
    }
  }
  close() {
    this.closed = true;
    const reason = failure("OAUTH_CLOSED", "OAuth 流程已关闭");
    for (const controller of this.exchanges) controller.abort(reason);
    for (const id of this.flows.keys()) this.forget(id, reason);
  }
}
