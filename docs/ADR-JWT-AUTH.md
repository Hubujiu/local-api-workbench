# JWT 本地签名认证

## 明确契约

JWT 是一个独立认证类型。只使用请求中明确配置的 Secret/PEM 私钥与 Payload，在本机通过固定版本 jose 6.2.13 签名；不登录、不获取密钥、不读取密钥文件、不自动刷新令牌。默认 Authorization: Bearer，也可明确选择 Query 参数发送；同名 Query 参数会被替换，而不是追加多个令牌。

支持 HS256/384/512、RS256/384/512、PS256/384/512、ES256/384/512。禁止 none 和算法降级。HMAC 的密钥至少分别为 32/48/64 字节，并拒绝把 PEM 公私钥当作 HMAC Secret；长度限制不等于保证密钥随机性。RSA 使用普通 RSA 私钥且为 2048 至 8192 位；ECDSA 分别要求 P-256/P-384/P-521。可明确选择规范 Base64 编码的 Secret，私钥仅支持未加密 PEM，不解析加密私钥，避免引入不可控的口令派生开销。

Payload 和 Header 必须为 JSON 对象文本，UTF-8 分别最多 8KiB 和 2KiB，Secret 最多 64KiB，输出令牌最多 16KiB。Payload 保留用户输入的 JSON 字节，不自动加入 iat、exp、iss 或 aud。JWT 本身不是加密；服务端仍须按自身策略验证签名、算法、受众、有效期和权限。

Header 仅允许 alg、typ、cty、kid；alg 必须与选项一致。暂不支持 crit、未编码 Payload、嵌入/远程 JWK 或证书头。这里没有密钥发现、JWE 或令牌验签工具。原生 rsa-pss 限定型私钥（并非普通 RSA 私钥的 PS 签名）、EdDSA 和 ASAP 也不属于本切片。

## 编辑、导入与导出

请求、共享认证及计划步骤使用同一认证面板与字段。Secret/PEM 用多行输入，不增加私钥口令输入；保存接口/步骤仍会把凭据明文写入本地项目。不要把真实凭据提交到 Git 或分享项目。Query 令牌可能出现在 URL、历史与日志中，应优先使用 HTTPS Header。

支持明确映射现代 Apipost/公开旧格式与 Postman 的 JWT 配置字段。未知字段/算法/发送位置拒绝，不静默丢弃依赖；导入本身不执行请求或签名。该字段映射不证明原生 Offline2 项目可完整迁移。

OpenAPI 导出只声明 Bearer JWT 或 API Key 形式的安全方案，不输出签名 Secret、私钥或 Payload，也不能用于还原完整签名配置。需要完整配置时使用本工具项目备份并检查敏感信息。cURL 导出明确拒绝 JWT 动态签名配置，避免生成缺少认证的命令或暗中导出签名密钥。

## 固定验证入口

- tests/jwt-auth.test.mjs：12 种算法由独立 Node crypto 验签；编码/输入上限/密钥类型/头字段/错误预先拒绝；本机真实 HTTP 的 Header 与 Query；导入和不含密钥的 OpenAPI 声明。
- tests/auth-view.test.mjs：算法选项、字段、HTML 转义及共享表单。
- tests/ui-smoke.mjs：真实浏览器编辑 Header/Query JWT，由独立本机服务验签并核对载荷，保留截图。
- tests/desktop-smoke.mjs：实际打包应用分别执行 HMAC/RSA/PSS/ECDSA，由外部测试进程验签，防止仅开发环境具有依赖。原 watchdog 和签名安全边界不放宽。

## 依据

- [RFC 7518](https://www.rfc-editor.org/rfc/rfc7518)：JWA 算法、密钥与签名要求。
- [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515)：JWS Compact Serialization。
- [固定版本公开 JWT 字段](https://github.com/EchoAPI-Team/echoapi-for-vscode/blob/bc8ecb58271ac7a8b0289fad2f0455745b4562f1/src/types/apis/auth.ts)及其[JWT 配置面板](https://github.com/EchoAPI-Team/echoapi-for-vscode/blob/bc8ecb58271ac7a8b0289fad2f0455745b4562f1/src/components/business/Request/Auth/components/Jwt.tsx)，只用于互操作字段研究，没有复制其实现。
- 签名库 jose，固定生产依赖 6.2.13，MIT；不使用额外手写密码算法。
