// Validate decoded Engine.IO metadata before handing it to the upstream state machine.
// Message framing and Socket.IO parsing remain owned by the official libraries.
export function checkedEngineIOPacket(packet, establishedId) {
  if (packet.type !== "open") return packet;
  if (establishedId) throw Error("Engine.IO重复握手");
  if (typeof packet.data !== "string")
    throw Error("Engine.IO握手必须是JSON文本");
  let data;
  try {
    data = JSON.parse(packet.data);
  } catch {
    throw Error("Engine.IO握手JSON无效");
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.sid !== "string" ||
    !data.sid ||
    data.sid.length > 256 ||
    !data.sid.isWellFormed() ||
    /[\x00-\x1f\x7f]/.test(data.sid) ||
    !Array.isArray(data.upgrades) ||
    data.upgrades.length > 8 ||
    data.upgrades.some((v) => typeof v !== "string" || !v || v.length > 32)
  )
    throw Error("Engine.IO握手会话或升级列表无效");
  for (const key of ["pingInterval", "pingTimeout"])
    if (!Number.isInteger(data[key]) || data[key] < 1 || data[key] > 300000)
      throw Error("Engine.IO握手心跳期限无效");
  if (!Number.isSafeInteger(data.maxPayload) || data.maxPayload < 1)
    throw Error("Engine.IO握手载荷上限无效");
  // A client may send less than the server accepts; never exceed our own acquisition budget.
  return {
    ...packet,
    data: JSON.stringify({
      ...data,
      maxPayload: Math.min(data.maxPayload, 1024 * 1024),
    }),
  };
}
