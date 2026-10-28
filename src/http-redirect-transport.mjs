import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { prepareConnection } from "./connection.mjs";
import {
  throwIfInactive,
  interruptionKind,
  requestTimeout,
} from "./request-control.mjs";
import {
  REDIRECT_BYTE_LIMIT,
  redirectDecision,
  dropEntityHeaders,
  redirectStateKey,
  httpRedirectFailure,
} from "./http-redirect.mjs";

// Receives already prepared bytes. It never re-enters request normalization,
// templates, query appending, authentication or multipart encoding.
export async function executePreparedRedirect(
  r,
  initial,
  preparedHeaders,
  preparedBody,
  controls,
  cookieSession,
  onResponse = () => {},
) {
  let url = new URL(initial),
    method = r.method,
    headers = { ...preparedHeaders },
    body = preparedBody;
  let latest,
    complete = false,
    started = false,
    attempted = url.href;
  const trace = [],
    seen = new Set(),
    budget = { encoded: 0, decoded: 0 };
  const start = performance.now();
  const failure = (reason) =>
    httpRedirectFailure(latest, reason, trace, attempted, started, complete);
  const classify = (error) => {
    try {
      throwIfInactive(controls);
    } catch (interruption) {
      return interruptionKind(interruption) === "cancelled"
        ? "cancelled"
        : "timeout";
    }
    return interruptionKind(error) === "timeout"
      ? "timeout"
      : error?.redirectBudget === true
        ? "response-budget"
        : "transport";
  };
  for (let hop = 0; ; hop++) {
    attempted = url.href;
    started = false;
    try {
      throwIfInactive(controls);
    } catch (error) {
      throw failure(classify(error));
    }
    const key = redirectStateKey(url, method, headers, body);
    if (seen.has(key)) throw failure("loop");
    seen.add(key);
    const wire = new URL(url);
    wire.hash = "";
    let connection;
    try {
      connection = await prepareConnection(
        wire,
        { ...r, timeout: controls.deadline - performance.now() },
        headers,
        controls.signal,
      );
      throwIfInactive(controls);
      latest = await exchange(
        connection,
        url,
        method,
        headers,
        body,
        controls,
        budget,
        start,
        (response) => {
          latest = response;
          complete = false;
          onResponse(response);
        },
        () => {
          started = true;
        },
      );
      complete = true;
    } catch (error) {
      throw failure(classify(error));
    } finally {
      connection?.cleanup();
    }
    trace.push({
      url: url.href,
      method,
      status: latest.status,
      size: latest.size,
    });
    if (Buffer.byteLength(JSON.stringify(trace)) > 256 * 1024)
      throw failure("response-budget");
    const decision = redirectDecision(latest, url, initial.origin, method);
    try {
      throwIfInactive(controls);
      if (cookieSession)
        await cookieSession.capture(
          url.href,
          latest.headers["set-cookie"],
          controls,
        );
      throwIfInactive(controls);
    } catch (error) {
      const reason = classify(error);
      if (reason !== "transport" || decision)
        throw failure(reason === "transport" ? "cookie" : reason);
      latest.cookieError = "Cookie保存失败";
    }
    if (!decision) {
      if (/msgpack/i.test(latest.headers["content-type"] || "")) {
        latest.rawBodyBase64 = latest._redirectRaw.toString("base64");
        try {
          const { decode } = await import("@msgpack/msgpack");
          latest.body = JSON.stringify(
            decode(latest._redirectRaw, {
              useBigInt64: true,
              maxStrLength: 8388608,
              maxBinLength: 8388608,
              maxArrayLength: 100000,
              maxMapLength: 100000,
              maxExtLength: 8388608,
            }),
            (_key, value) =>
              typeof value === "bigint"
                ? value.toString()
                : value instanceof Uint8Array
                  ? {
                      type: "binary",
                      base64: Buffer.from(value).toString("base64"),
                    }
                  : value,
            2,
          );
        } catch (error) {
          latest.codecError = error.message;
          latest.body = latest.rawBodyBase64;
        }
      }
      delete latest._redirectRaw;
      try {
        throwIfInactive(controls);
      } catch (error) {
        throw failure(classify(error));
      }
      latest.redirectTrace = trace;
      latest.effectiveUrl = url.href;
      return latest;
    }
    if (decision.reason) throw failure(decision.reason);
    if (hop >= r.redirect.maxHops) throw failure("hops");
    url = decision.target;
    method = decision.method;
    headers = { ...headers };
    if (decision.dropBody) {
      body = undefined;
      dropEntityHeaders(headers);
    }
    delete headers.cookie;
    attempted = url.href;
    started = false;
    try {
      throwIfInactive(controls);
      if (cookieSession) {
        const managed = await cookieSession.header(url.href, controls);
        if (managed) headers.cookie = managed;
      }
      throwIfInactive(controls);
    } catch (error) {
      const reason = classify(error);
      throw failure(reason === "transport" ? "cookie" : reason);
    }
  }
}

function exchange(
  connection,
  url,
  method,
  headers,
  body,
  controls,
  budget,
  start,
  onHeaders,
  onStarted,
) {
  return new Promise((resolve, reject) => {
    let req,
      timer,
      stream,
      res,
      response,
      settled = false;
    const chunks = [];
    const refresh = () => {
      if (!response) return;
      const raw = Buffer.concat(chunks);
      Object.defineProperty(response, "_redirectRaw", {
        value: raw,
        configurable: true,
      });
      response.body = raw.toString("utf8");
      response.duration = Math.round((performance.now() - start) * 100) / 100;
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      refresh();
      if (error) {
        stream?.destroy();
        res?.destroy();
        req?.destroy();
        reject(error);
      } else resolve(response);
    };
    const overflow = () => {
      const error = Error("redirect response budget exceeded");
      error.redirectBudget = true;
      finish(error);
    };
    try {
      throwIfInactive(controls);
      req = connection.client.request(
        connection.url,
        { method, headers, signal: controls.signal, ...connection.options },
        (incoming) => {
          res = incoming;
          response = {
            status: res.statusCode,
            protocol: res.httpVersion || "1.1",
            statusText: res.statusMessage,
            headers: res.headers,
            rawHeaders: res.rawHeaders || [],
            body: "",
            size: 0,
            duration: Math.round((performance.now() - start) * 100) / 100,
            request: {
              method,
              url: url.href,
              headers: { ...headers },
              body: body?.toString() || "",
            },
          };
          onHeaders(response);
          const encoding = res.headers["content-encoding"];
          const decoder =
            encoding === "gzip"
              ? createGunzip()
              : encoding === "deflate"
                ? createInflate()
                : encoding === "br"
                  ? createBrotliDecompress()
                  : null;
          stream = decoder || res;
          res.on("data", (chunk) => {
            budget.encoded += chunk.length;
            if (budget.encoded > REDIRECT_BYTE_LIMIT) overflow();
          });
          res.on("aborted", () => finish(Error("HTTP response interrupted")));
          res.on("error", finish);
          stream.on("error", finish);
          stream.on("data", (chunk) => {
            if (settled) return;
            budget.decoded += chunk.length;
            if (budget.decoded > REDIRECT_BYTE_LIMIT) {
              overflow();
              return;
            }
            chunks.push(chunk);
            response.size += chunk.length;
          });
          stream.on("end", () => finish());
          if (decoder) res.pipe(decoder);
        },
      );
      req.on("error", finish);
      const remaining = Math.max(
        1,
        Math.ceil(controls.deadline - performance.now()),
      );
      timer = setTimeout(() => finish(requestTimeout()), remaining);
      req.setTimeout(remaining, () => finish(requestTimeout()));
      onStarted();
      if (body) req.write(body);
      req.end();
    } catch (error) {
      finish(error);
    }
  });
}
