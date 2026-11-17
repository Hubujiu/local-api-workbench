export function imageDimensions(bytes, mime) {
  const b = bytes,
    u16 = (i) => (b[i] << 8) | b[i + 1],
    u32 = (i) =>
      new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i);
  let width = 0,
    height = 0;
  if (mime === "image/png") {
    if (
      b.length < 33 ||
      [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => b[i] !== v) ||
      String.fromCharCode(...b.slice(12, 16)) !== "IHDR"
    )
      throw Error("PNG文件头无效");
    width = u32(16);
    height = u32(20);
  } else if (mime === "image/jpeg") {
    if (b.length < 4 || b[0] !== 255 || b[1] !== 216)
      throw Error("JPEG文件头无效");
    let i = 2;
    while (i + 3 < b.length) {
      if (b[i++] !== 255) throw Error("JPEG标记无效");
      while (b[i] === 255) i++;
      const marker = b[i++];
      if (marker === 217 || marker === 218) break;
      const length = u16(i);
      if (length < 2 || i + length > b.length) throw Error("JPEG段无效");
      if ([192, 193, 194].includes(marker)) {
        if (length < 8) throw Error("JPEG尺寸无效");
        height = u16(i + 3);
        width = u16(i + 5);
        break;
      }
      i += length;
    }
  } else throw Error("仅支持PNG/JPEG图片");
  if (
    !width ||
    !height ||
    width > 4096 ||
    height > 4096 ||
    width * height > 16000000
  )
    throw Error("图片尺寸须不超过4096边长和1600万像素");
  return { width, height };
}
export function inlineImageURI(bytes, mime) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024)
    throw Error("图片最多128KiB");
  imageDimensions(bytes, mime);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return "data:" + mime + ";base64," + btoa(binary);
}
export function inlineImagePixels(uri) {
  if (typeof uri !== "string" || uri.length > 175000) return 0;
  const match =
    /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
  if (!match) return 0;
  try {
    const binary = atob(match[2]);
    if (binary.length > 128 * 1024) return 0;
    const { width, height } = imageDimensions(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
      match[1],
    );
    return width * height;
  } catch {
    return 0;
  }
}

export const validInlineImage = (uri) => inlineImagePixels(uri) > 0;
