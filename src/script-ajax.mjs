/** This factory executes only inside QuickJS, using the existing HTTP broker. */
export const ajaxCompatibilitySource = String(
  function installAjax(sendRequest) {
    const invoke = (callback, args) => {
      if (!callback) return;
      const result = callback(...args);
      if (result && typeof result.then === "function")
        throw Error("ajax回调暂不支持Promise返回");
    };
    const scalar = (value) => {
      if (value === null) return "";
      if (!["string", "number", "boolean"].includes(typeof value))
        throw Error("ajax data仅支持字符串或标量字段对象");
      return String(value);
    };
    globalThis.$ = Object.freeze({
      ajax(options) {
        if (!options || typeof options !== "object" || Array.isArray(options))
          throw Error("ajax需要配置对象");
        const supported = [
          "url",
          "method",
          "type",
          "headers",
          "contentType",
          "content-type",
          "data",
          "dataType",
          "timeout",
          "success",
          "error",
          "complete",
          "async",
        ];
        for (const key of Object.keys(options))
          if (!supported.includes(key)) throw Error("ajax暂不支持选项: " + key);
        if (options.async !== undefined && options.async !== true)
          throw Error("ajax不支持async:false；使用回调形式");
        for (const name of ["success", "error", "complete"])
          if (
            options[name] !== undefined &&
            typeof options[name] !== "function"
          )
            throw Error("ajax " + name + "需要回调函数");
        if (
          options.dataType !== undefined &&
          !["json", "text"].includes(options.dataType)
        )
          throw Error("ajax dataType仅支持json/text");
        if (typeof options.url !== "string") throw Error("ajax需要URL");
        const method = String(
          options.method || options.type || "GET",
        ).toUpperCase();
        const headers = options.headers === undefined ? {} : options.headers;
        if (!headers || typeof headers !== "object" || Array.isArray(headers))
          throw Error("ajax headers需要键值对象");
        const copiedHeaders = { ...headers };
        const contentType = options.contentType ?? options["content-type"];
        if (contentType !== undefined) {
          if (typeof contentType !== "string")
            throw Error("ajax contentType需要字符串");
          for (const key of Object.keys(copiedHeaders))
            if (key.toLowerCase() === "content-type") delete copiedHeaders[key];
          copiedHeaders["content-type"] = contentType;
        }
        let url = options.url,
          data = options.data;
        if (data !== undefined && typeof data !== "string") {
          if (
            Object.entries(copiedHeaders).some(
              ([key, value]) =>
                key.toLowerCase() === "content-type" &&
                /\bjson\b/i.test(String(value)),
            )
          )
            throw Error(
              "ajax JSON data必须先JSON.stringify，不能把对象误编码为表单",
            );
          if (!data || typeof data !== "object" || Array.isArray(data))
            throw Error("ajax data需要字符串或字段对象");
          if (Object.keys(data).length > 100) throw Error("ajax data最多100项");
          data = Object.entries(data)
            .map(
              ([key, value]) =>
                encodeURIComponent(key) +
                "=" +
                encodeURIComponent(scalar(value)),
            )
            .join("&")
            .replace(/%20/g, "+");
        }
        if (data !== undefined && ["GET", "HEAD"].includes(method)) {
          const index = url.indexOf("#");
          const fragment = index < 0 ? "" : url.slice(index);
          url = index < 0 ? url : url.slice(0, index);
          if (data)
            url +=
              (url.includes("?") ? (/[?&]$/.test(url) ? "" : "&") : "?") + data;
          url += fragment;
          data = undefined;
        }
        if (
          data !== undefined &&
          !Object.keys(copiedHeaders).some(
            (key) => key.toLowerCase() === "content-type",
          )
        )
          copiedHeaders["content-type"] =
            "application/x-www-form-urlencoded; charset=UTF-8";
        sendRequest(
          {
            url,
            method,
            headers: copiedHeaders,
            ...(data === undefined ? {} : { body: data }),
            ...(options.timeout === undefined
              ? {}
              : { timeout: options.timeout }),
          },
          (error, response) => {
            const xhr = {
              status: response?.code || 0,
              statusText: response?.status || "",
              responseText: response?.text() || "",
              getResponseHeader: (name) => response?.headers.get(name),
            };
            let status = "success",
              value = xhr.responseText,
              failure = error;
            if (
              !failure &&
              !((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304)
            )
              failure = Error("HTTP " + xhr.status);
            if (failure) status = "error";
            else if (xhr.status === 204 || method === "HEAD") {
              status = "nocontent";
              value = undefined;
            } else if (xhr.status === 304) {
              status = "notmodified";
              value = undefined;
            } else if (
              options.dataType === "json" ||
              (options.dataType === undefined &&
                /\bjson\b/i.test(response?.headers.get("content-type") || ""))
            ) {
              try {
                value = JSON.parse(xhr.responseText);
                xhr.responseJSON = value;
              } catch (error) {
                failure = error;
                status = "parsererror";
              }
            }
            try {
              if (failure) {
                if (options.error)
                  invoke(options.error, [xhr, status, failure]);
                else throw failure;
              } else invoke(options.success, [value, status, xhr]);
            } finally {
              invoke(options.complete, [xhr, status]);
            }
          },
        );
      },
    });
  },
);
