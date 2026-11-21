import { icon } from "./icons.js";

const cookieColumns = [
  "Name",
  "Value",
  "Domain",
  "Path",
  "Expires",
  "HttpOnly",
  "Secure",
];

export function unsentResponseData(tab) {
  const status = `<div class="unsent-response-message"><span aria-hidden="true">${icon("body-empty")}</span><p>暂无数据</p></div>`;
  if (tab === "headers")
    return `<section class="unsent-response-data" data-unsent-response="headers" aria-label="尚无响应头">${status}</section>`;
  if (tab === "cookies")
    return `<div class="unsent-response-data unsent-response-cookie-scroll" data-unsent-response="cookies" role="region" aria-label="响应 Cookie 表格滚动区" tabindex="0"><table aria-label="响应 Cookie"><thead><tr>${cookieColumns.map((column) => `<th scope="col">${column}</th>`).join("")}</tr></thead><tbody><tr><td colspan="${cookieColumns.length}">${status}</td></tr></tbody></table></div>`;
  return "";
}
