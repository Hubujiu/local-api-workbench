# Windows 首次安装工程候选（仅编译，禁止当正式发行）

本切片从显式、已核验来源的 x64 Windows payload 生成 NSIS 源码；不自动下载工具，
不编译、不执行安装器、不注册、不上传。使用前须独立核验外层 ZIP 摘要和来源。
此候选拒绝 payload 文件名中的 `$`，不猜测 NSIS 变量转义语义。
显式 manifest 摘要绑定输入字节，但单独的自述 head/摘要不认证发布者。

```text
python scripts/prepare_windows_first_install.py --payload /verified/staged --manifest /verified/staged/build-manifest.json --manifest-sha256 <independently-verified-sha256> --output /fresh/build --head <exact-product-head> --version 0.1.0
NSISDIR=/private/nsis/share/nsis /private/nsis/bin/makensis -NOCONFIG -WX /fresh/build/first-install.nsi
```

只允许受控静止、一次性标准用户 Windows 测试环境。编译器使用已独立验证的 NSIS 3.12-1。
生成路径固定为当前用户 LOCALAPPDATA 下 `LocalAPI-FirstInstall-Candidate`，与正常 Electron
roaming userData 分离；若 LOCAL_API_DESKTOP_DATA 非空拒绝。无目录选择页；初始化和写入前重新
设置固定目标，因此 `/D=` 不生效。拒绝静默模式，不请求提权，但**没有检查外部已经提权的 token**。
组件页要求用户点击 Install，不接受任何新法律条款。

现有祖先逐层检查目录与 reparse 属性；固定盘以外拒绝。final 与同父 `.pending` 均必须缺失且可检查（GetFileAttributesW 只接受 ERROR_FILE_NOT_FOUND）；
CreateDirectoryW 必须成功新建 `.pending`，
已有空目录、文件、链接、junction 和大小写别名不作为升级入口。逐文件检查不存在、禁止覆盖，
文件复制失败中止且退出非零。全部文件只提取到 pending；完成后检查祖先，以不创建目录的 SetCurrentDirectoryW 离开该工作目录，并检查返回值；再复核祖先、
final 缺失及 pending 非 reparse 目录，才以 MoveFileExW flags=0 改名发布到 final。
不允许 REPLACE_EXISTING 或 COPY_ALLOWED；改名失败不报成功。CRCCheck force 不接受关闭安装器 CRC 检查。
不自动启动/终止应用，不删文件，不写注册表，不创建卸载器，不做升级、修复、迁移或卸载。

## 必须保留的边界

这不是事务安装器：写入开始后失败或断电会留下 pending 目录，必须保留；不得当作成功包运行，
后续尝试拒绝既存 final/pending 目录，无自动回滚、清理或覆盖。没有句柄固定的文件树，因此不抗同用户恶意
并发替换、重解析点竞争；受控静止路径是前提。仅成功改名后输出发布完成提示；此提示不是逐文件运行时哈希复验或
Windows 安装验收。无签名、SmartScreen、管理员 token、首次启动、升级/卸载实测声明。

后续仅在单独获准的一次性 Windows 环境验收：标准用户首次创建、已有普通/空目录/文件及
大小写别名拒绝、祖先 junction 拒绝、/S 与 /D、取消、磁盘不足/写失败、部分目录拒绝重试；
核非零退出与源/外部数据不变。启动需另行授权，核无 override 的默认 userData/projects，
不迁移旧试用路径。必须保存真实证据，不以源码字符串测试或交叉编译代替运行。

待原生验收补充：提取中断和写错误只留下 pending 而非 final；已存在/不可访问 pending 在任何写入前拒绝；
提取后 final 被其他进程建立时发布失败且不覆盖，pending 保留；SetCurrentDirectoryW 或重命名失败无完成提示。
这些是待测合同，不是 Linux 静态测试证明。NSIS 错误捕获使用官方
[System 插件 ?e](https://nsis.sourceforge.io/Docs/System/System.html) 返回的即时 Win32 error。
