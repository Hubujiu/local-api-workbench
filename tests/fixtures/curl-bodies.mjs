export const quoteCurl = (value) =>
  "'" + String(value).replaceAll("'", "'\\''") + "'";
export const curlBodyCases = [
  {
    args: ["--data-raw", "a\\qb"],
    syntax: String.raw`--data-raw "a\qb"`,
    body: "a\\qb",
  },
  {
    args: ["--data-raw", "joined"],
    syntax: "--data-raw \\\n 'joined'",
    body: "joined",
  },
  {
    args: ["--data-raw", "cost $5"],
    syntax: String.raw`--data-raw "cost \$5"`,
    body: "cost $5",
  },
  {
    args: ["--data-raw", "$HOME;literal"],
    syntax: "--data-raw '$HOME;literal'",
    body: "$HOME;literal",
  },
  { args: ["-d", "a=1", "-d", "b=two"], body: "a=1&b=two" },
  { args: ["-d", "", "-d", "a=1"], body: "a=1", ambiguousLeadingEmpty: true },
  { args: ["-d", ""], body: "" },
  { args: ["-d", "a=1", "-d", ""], body: "a=1&" },
  {
    args: ["--data-raw", "@literal", "--data-binary", "a\r\nb"],
    body: "@literal&a\r\nb",
  },
  {
    args: ["--data-urlencode", "q=中文 +!~*'", "--data-urlencode", "=a@b"],
    body: "q=%E4%B8%AD%E6%96%87+%2B%21~%2A%27&a%40b",
  },
  {
    args: ["--data-urlencode", "field%20name=value=1"],
    body: "field%20name=value%3D1",
  },
  {
    args: ["--json", '{"ok":', "--json", "true}"],
    body: '{"ok":true}',
    contentType: "application/json",
    accept: "application/json",
  },
  {
    args: [
      "--json",
      "not json",
      "-H",
      "Content-Type: text/plain",
      "-H",
      "Accept: text/plain",
    ],
    body: "not json",
    contentType: "text/plain",
    accept: "text/plain",
  },
  {
    args: ["--json", "false", "-H", "Content-Type:"],
    body: "false",
    contentType: null,
    accept: "application/json",
  },
  {
    args: ["--json", "false", "-H", "Content-Type;", "-H", "Accept:"],
    body: "false",
    contentType: "",
    accept: null,
  },
  { args: ["--data-ascii", "x=1", "-X", "GET"], body: "x=1", method: "GET" },
];
