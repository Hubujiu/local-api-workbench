import { randomBytes, createHash } from "node:crypto";
import { executeRequest } from "./runtime.mjs";

function endpoint(value) {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("OAuth endpoint 无效");
  return url;
}
export async function exchangeOAuthToken(config, extra = {}) {
  endpoint(config.tokenEndpoint);
  const fields = { ...extra };
  if (config.scope) fields.scope = config.scope;
  let auth = { type: "none" };
  if (config.clientAuthentication === "basic")
    auth = {
      type: "basic",
      username: config.clientId || "",
      password: config.clientSecret || "",
    };
  else {
    fields.client_id = config.clientId || "";
    if (config.clientSecret) fields.client_secret = config.clientSecret;
  }
  const response = await executeRequest({
    method: "POST",
    url: config.tokenEndpoint,
    auth,
    bodyType: "urlencoded",
    form: Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({ key, value, enabled: true })),
    timeout: 15000,
  });
  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    throw Error("OAuth token endpoint 返回非 JSON 响应");
  }
  if (response.status < 200 || response.status >= 300 || !data.access_token)
    throw Error(
      data.error_description || data.error || "OAuth token exchange failed",
    );
  return {
    accessToken: data.access_token,
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token,
    scope: data.scope,
  };
}
export class OAuthManager {
  constructor() {
    this.flows = new Map();
  }
  prune() {
    for (const [id, flow] of this.flows)
      if (flow.expiresAt < Date.now()) this.flows.delete(id);
  }
  start(config, baseURL) {
    this.prune();
    if (this.flows.size >= 10) throw Error("OAuth 流程过多，请稍后重试");
    const authorization = endpoint(config.authorizationEndpoint);
    endpoint(config.tokenEndpoint);
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
    this.flows.set(id, {
      id,
      state,
      verifier,
      redirectUri,
      authorizationUrl: authorization.href,
      config: structuredClone(config),
      status: "pending",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return { id, authorizationUrl: authorization.href, redirectUri };
  }
  allowed(url) {
    this.prune();
    return [...this.flows.values()].some(
      (flow) => flow.status === "pending" && flow.authorizationUrl === url,
    );
  }
  status(id) {
    this.prune();
    const flow = this.flows.get(id);
    if (!flow) throw Error("OAuth 流程已过期");
    return { status: flow.status, result: flow.result, error: flow.error };
  }
  async complete(params) {
    this.prune();
    const flow = [...this.flows.values()].find(
      (flow) => flow.state === params.state,
    );
    if (!flow || flow.status !== "pending")
      throw Error("OAuth state 无效、过期或已使用");
    flow.status = "exchanging";
    try {
      if (params.error) throw Error(params.error_description || params.error);
      if (!params.code) throw Error("回调缺少授权码");
      flow.result = await exchangeOAuthToken(flow.config, {
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.verifier,
      });
      flow.status = "completed";
      delete flow.config;
      delete flow.verifier;
      delete flow.state;
      return { ok: true };
    } catch (error) {
      flow.status = "error";
      flow.error = error.message;
      delete flow.config;
      delete flow.verifier;
      throw error;
    }
  }
  close() {
    this.flows.clear();
  }
}
