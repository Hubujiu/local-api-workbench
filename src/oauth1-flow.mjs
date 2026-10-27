import { randomBytes } from "node:crypto";
import { executeRequest } from "./runtime.mjs";
function endpoint(value) {
  const u = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (
    (u.protocol !== "https:" && !(u.protocol === "http:" && local)) ||
    u.username ||
    u.password ||
    u.hash
  )
    throw Error("OAuth1 endpoint须为HTTPS（仅本机允许HTTP），不可含凭据或片段");
  for (const k of u.searchParams.keys())
    if (k.startsWith("oauth_")) throw Error("OAuth1 endpoint不能预置协议参数");
  return u;
}
async function exchange(url, auth, signal) {
  const response = await executeRequest(
    {
      url,
      method: "POST",
      bodyType: "urlencoded",
      form: [],
      auth: { ...auth, type: "oauth1" },
      timeout: 15000,
    },
    signal,
  );
  if (response.status < 200 || response.status >= 300)
    throw Error("OAuth1令牌交换失败，HTTP " + response.status);
  if (typeof response.body !== "string" || response.body.length > 65536)
    throw Error("OAuth1令牌响应过大或无效");
  const data = new URLSearchParams(response.body),
    seen = new Set();
  for (const [key] of data) {
    if (seen.has(key)) throw Error("OAuth1令牌响应字段重复");
    seen.add(key);
  }
  for (const key of ["oauth_token", "oauth_token_secret"])
    if (!data.get(key) || data.get(key).length > 8192)
      throw Error("OAuth1令牌响应缺少有效字段");
  return data;
}
const flowLifetime = 5 * 60 * 1000;
const callbackPrefix = "/oauth1/callback/";
function validVerifier(value) {
  return (
    typeof value === "string" &&
    value.trim() &&
    value.length <= 4096 &&
    value.isWellFormed() &&
    !/[\r\n\0]/.test(value)
  );
}
function callbackParameters(search) {
  if (typeof search !== "string" || search.length > 32768)
    throw Error("OAuth1回调参数无效");
  // URLSearchParams silently repairs malformed percent/UTF-8 sequences.
  try {
    decodeURIComponent(search.replace(/\+/g, " "));
  } catch {
    throw Error("OAuth1回调参数无效");
  }
  const data = new URLSearchParams(search);
  const seen = new Set();
  for (const [key] of data) {
    if (!["oauth_token", "oauth_verifier"].includes(key) || seen.has(key))
      throw Error("OAuth1回调参数无效");
    seen.add(key);
  }
  if (seen.size !== 2 || !validVerifier(data.get("oauth_verifier")))
    throw Error("OAuth1回调参数无效");
  return data;
}
export class OAuth1Manager {
  constructor() {
    this.flows = new Map();
    this.closed = false;
  }
  assertOpen() {
    if (this.closed) throw Error("OAuth1流程已关闭");
  }
  forget(id) {
    const flow = this.flows.get(id);
    if (!flow) return;
    this.flows.delete(id);
    clearTimeout(flow.timer);
    flow.controller.abort();
    delete flow.auth;
    delete flow.temporaryToken;
    delete flow.temporarySecret;
    delete flow.callbackPath;
    delete flow.result;
  }
  prune() {
    for (const [id, f] of this.flows)
      if (f.expiresAt <= Date.now()) this.forget(id);
  }
  active(flow) {
    this.assertOpen();
    this.prune();
    if (this.flows.get(flow.id) !== flow || flow.controller.signal.aborted)
      throw Error("OAuth1流程已关闭或过期");
  }
  async owned(flow, signal, operation) {
    const abort = () => this.forget(flow.id);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      this.active(flow);
      const result = await operation();
      this.active(flow);
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async start(config, baseURL, signal) {
    this.assertOpen();
    this.prune();
    if (this.flows.size >= 10) throw Error("OAuth1流程过多");
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      JSON.stringify(config).length > 65536
    )
      throw Error("OAuth1配置无效");
    const callbackMode =
      config.callbackMode === undefined ? "oob" : config.callbackMode;
    if (!["oob", "loopback"].includes(callbackMode))
      throw Error("OAuth1回调模式无效");
    if (
      callbackMode === "loopback" &&
      (typeof baseURL !== "string" ||
        !/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(baseURL) ||
        Number(baseURL.split(":").at(-1)) > 65535)
    )
      throw Error("OAuth1回调需要本机服务地址");
    const request = endpoint(config.requestTokenEndpoint),
      authorization = endpoint(config.authorizationEndpoint),
      token = endpoint(config.tokenEndpoint);
    const auth = {};
    for (const key of [
      "consumerKey",
      "consumerSecret",
      "signatureMethod",
      "privateKey",
      "privateKeyPassphrase",
      "realm",
      "version",
    ])
      if (config[key] !== undefined) {
        if (
          typeof config[key] !== "string" ||
          config[key].includes("{{") ||
          !config[key].isWellFormed()
        )
          throw Error("OAuth1授权请填写明确文本值");
        auth[key] = config[key];
      }
    const id = randomBytes(24).toString("hex"),
      controller = new AbortController();
    const callbackPath =
      callbackMode === "loopback"
        ? callbackPrefix + randomBytes(24).toString("hex")
        : undefined;
    const redirectUri = callbackPath ? baseURL + callbackPath : "oob";
    const flow = {
      id,
      auth,
      callbackMode,
      callbackPath,
      tokenEndpoint: token.href,
      controller,
      expiresAt: Date.now() + flowLifetime,
      status: "requesting",
    };
    this.flows.set(id, flow);
    flow.timer = setTimeout(() => this.forget(id), flowLifetime);
    flow.timer.unref?.();
    try {
      const data = await this.owned(flow, signal, () =>
        exchange(
          request.href,
          { ...auth, callback: redirectUri },
          controller.signal,
        ),
      );
      if (data.get("oauth_callback_confirmed") !== "true")
        throw Error("OAuth1服务未确认回调");
      flow.temporaryToken = data.get("oauth_token");
      flow.temporarySecret = data.get("oauth_token_secret");
      authorization.searchParams.set("oauth_token", flow.temporaryToken);
      flow.authorizationUrl = authorization.href;
      flow.status = "pending";
      return {
        id,
        authorizationUrl: authorization.href,
        expiresAt: flow.expiresAt,
        ...(callbackPath ? { redirectUri } : {}),
      };
    } catch (error) {
      this.forget(id);
      throw error;
    }
  }
  allowed(url) {
    this.prune();
    return (
      !this.closed &&
      [...this.flows.values()].some(
        (f) => f.status === "pending" && f.authorizationUrl === url,
      )
    );
  }
  status(id) {
    this.assertOpen();
    this.prune();
    const flow = this.flows.get(id);
    if (!flow) throw Error("OAuth1流程已过期或已使用");
    return {
      status: flow.status,
      expiresAt: flow.expiresAt,
      ...(flow.status === "error" ? { error: "OAuth1令牌交换失败" } : {}),
    };
  }
  cancel(id) {
    this.assertOpen();
    this.prune();
    if (!this.flows.has(id)) throw Error("OAuth1流程已过期或已使用");
    this.forget(id);
    return { ok: true };
  }
  async token(flow, verifier, signal) {
    // Claim before any await: callbacks and OOB completion cannot duplicate POSTs.
    flow.status = "exchanging";
    return this.owned(flow, signal, () =>
      exchange(
        flow.tokenEndpoint,
        {
          ...flow.auth,
          accessToken: flow.temporaryToken,
          tokenSecret: flow.temporarySecret,
          verifier,
        },
        flow.controller.signal,
      ),
    );
  }
  async callback(path, search, signal) {
    this.assertOpen();
    this.prune();
    const flow = [...this.flows.values()].find((f) => f.callbackPath === path);
    if (!flow || flow.callbackMode !== "loopback" || flow.status !== "pending")
      throw Error("OAuth1回调已过期或已使用");
    const data = callbackParameters(search);
    if (data.get("oauth_token") !== flow.temporaryToken)
      throw Error("OAuth1回调令牌不匹配");
    try {
      const result = await this.token(flow, data.get("oauth_verifier"), signal);
      flow.result = {
        accessToken: result.get("oauth_token"),
        tokenSecret: result.get("oauth_token_secret"),
      };
      flow.status = "completed";
      return { ok: true };
    } catch (error) {
      if (this.flows.get(flow.id) === flow) flow.status = "error";
      throw error;
    } finally {
      delete flow.auth;
      delete flow.temporaryToken;
      delete flow.temporarySecret;
      delete flow.callbackPath;
    }
  }
  async complete({ id, verifier } = {}, signal) {
    this.assertOpen();
    if (signal?.aborted) throw Error("OAuth1流程已取消");
    this.prune();
    const flow = this.flows.get(id);
    if (!flow) throw Error("OAuth1流程已过期或已使用");
    if (flow.callbackMode === "loopback") {
      if (flow.status !== "completed" || verifier !== undefined)
        throw Error("OAuth1回调尚未完成或领取参数无效");
      const result = { ...flow.result };
      this.forget(id);
      return result;
    }
    if (flow.status !== "pending") throw Error("OAuth1流程已过期或已使用");
    if (!validVerifier(verifier)) throw Error("OAuth1 verifier无效");
    try {
      const data = await this.token(flow, verifier, signal);
      return {
        accessToken: data.get("oauth_token"),
        tokenSecret: data.get("oauth_token_secret"),
      };
    } finally {
      this.forget(id);
    }
  }
  close() {
    this.closed = true;
    for (const id of this.flows.keys()) this.forget(id);
  }
}
