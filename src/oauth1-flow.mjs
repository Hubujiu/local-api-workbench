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
export class OAuth1Manager {
  constructor() {
    this.flows = new Map();
  }
  prune() {
    for (const [id, f] of this.flows)
      if (f.expiresAt < Date.now()) {
        f.controller.abort();
        this.flows.delete(id);
      }
  }
  async start(config) {
    this.prune();
    if (this.flows.size >= 10) throw Error("OAuth1流程过多");
    if (
      !config ||
      typeof config !== "object" ||
      JSON.stringify(config).length > 65536
    )
      throw Error("OAuth1配置无效");
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
        if (typeof config[key] !== "string" || config[key].includes("{{"))
          throw Error("OAuth1授权请填写明确文本值");
        auth[key] = config[key];
      }
    const id = randomBytes(24).toString("hex"),
      controller = new AbortController();
    const flow = {
      auth,
      tokenEndpoint: token.href,
      controller,
      expiresAt: Date.now() + 5 * 60 * 1000,
      status: "requesting",
    };
    this.flows.set(id, flow);
    try {
      const data = await exchange(
        request.href,
        { ...auth, callback: "oob" },
        controller.signal,
      );
      if (data.get("oauth_callback_confirmed") !== "true")
        throw Error("OAuth1服务未确认OOB回调");
      if (!this.flows.has(id) || controller.signal.aborted)
        throw Error("OAuth1流程已关闭");
      flow.temporaryToken = data.get("oauth_token");
      flow.temporarySecret = data.get("oauth_token_secret");
      authorization.searchParams.set("oauth_token", flow.temporaryToken);
      flow.authorizationUrl = authorization.href;
      flow.status = "pending";
      return {
        id,
        authorizationUrl: authorization.href,
        expiresAt: flow.expiresAt,
      };
    } catch (error) {
      this.flows.delete(id);
      throw error;
    }
  }
  allowed(url) {
    this.prune();
    return [...this.flows.values()].some(
      (f) => f.status === "pending" && f.authorizationUrl === url,
    );
  }
  async complete({ id, verifier } = {}) {
    this.prune();
    const flow = this.flows.get(id);
    if (!flow || flow.status !== "pending")
      throw Error("OAuth1流程已过期或已使用");
    if (
      typeof verifier !== "string" ||
      !verifier.trim() ||
      verifier.length > 4096 ||
      /[\r\n\0]/.test(verifier)
    )
      throw Error("OAuth1 verifier无效");
    flow.status = "exchanging";
    try {
      const data = await exchange(
        flow.tokenEndpoint,
        {
          ...flow.auth,
          accessToken: flow.temporaryToken,
          tokenSecret: flow.temporarySecret,
          verifier,
        },
        flow.controller.signal,
      );
      if (flow.controller.signal.aborted || !this.flows.has(id))
        throw Error("OAuth1流程已关闭");
      return {
        accessToken: data.get("oauth_token"),
        tokenSecret: data.get("oauth_token_secret"),
      };
    } finally {
      this.flows.delete(id);
    }
  }
  close() {
    for (const flow of this.flows.values()) flow.controller.abort();
    this.flows.clear();
  }
}
