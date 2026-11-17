// Inspect UI text before Number() erases hexadecimal/exponent syntax. Keep
// provider wrappers so the existing MySQL message and input contract stay fixed.
function decimalPortInput(raw, label) {
  const text = raw.trim();
  if (!text) return 0;
  if (!/^\d+$/.test(text))
    throw Error(`${label}端口须为十进制整数0至65535；留空或0使用默认端口`);
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error(`${label}端口须为十进制整数0至65535；留空或0使用默认端口`);
  return port;
}
export function mysqlPortInput(raw) {
  return decimalPortInput(raw, "MySQL");
}
export function mongoPortInput(raw) {
  return decimalPortInput(raw, "MongoDB");
}
