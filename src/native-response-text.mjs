// Serialized trusted implementation. Capture the current response object and
// intrinsics before user code; never call a public text() or a body accessor.
function createNativeResponseTextReader(response) {
  const descriptor = Object.getOwnPropertyDescriptor,
    hasOwn = Object.hasOwn,
    charCode = Function.prototype.call.bind(String.prototype.charCodeAt),
    NativeError = Error;
  return () => {
    const property = response && descriptor(response, "body");
    if (
      !property?.enumerable ||
      !hasOwn(property, "value") ||
      typeof property.value !== "string"
    )
      throw new NativeError("原生Text需要当前响应的自有字符串正文");
    const value = property.value;
    if (value.length > 65536) throw new NativeError("原生Text正文超过64KiB");
    let bytes = 0;
    for (let at = 0; at < value.length; at++) {
      const code = charCode(value, at);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = charCode(value, ++at);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw new NativeError("原生Text正文包含无效Unicode");
        bytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw new NativeError("原生Text正文包含无效Unicode");
      else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (bytes > 65536) throw new NativeError("原生Text正文超过64KiB");
    }
    return value;
  };
}

export const nativeResponseTextReaderSource =
  createNativeResponseTextReader.toString();
