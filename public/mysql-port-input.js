// Inspect the UI text before Number() erases hexadecimal/exponent syntax.
// Other providers retain their separate input/default contracts.
export function mysqlPortInput(raw) {
  const text = raw.trim();
  if (!text) return 0;
  if (!/^\d+$/.test(text))
    throw Error("MySQL端口须为十进制整数0至65535；留空或0使用默认端口");
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("MySQL端口须为十进制整数0至65535；留空或0使用默认端口");
  return port;
}
