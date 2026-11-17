import { nativeOAuth2Definition } from "../public/native-oauth2-model.js";
const fail = () => {
  throw Error("原生 OAuth2 定义无法保真映射，请使用项目备份");
};
// Pure data conversion: no token acquisition, template evaluation or network.
export function importApipostOAuth2(value) {
  try {
    return {
      type: "oauth2",
      nativeOAuth2: nativeOAuth2Definition({
        type: "oauth2",
        nativeOAuth2: value,
      }),
    };
  } catch {
    fail();
  }
}
export function exportApipostOAuth2(value) {
  try {
    const definition = nativeOAuth2Definition(value);
    if (definition === undefined) fail();
    return { type: "oauth2", oauth2: definition };
  } catch {
    fail();
  }
}
