# DM8 只读驱动

`npm run build:dameng` 用当前平台的 Rust 工具链、已提交的 Cargo.lock 和仓库内的驱动源码构建单次查询子进程，同时生成随桌面应用分发的第三方声明。数据库地址、授权表和密码经标准输入传入。每次查询使用独立连接，结果在事务回滚和进程退出后交付。

本目录嵌入 Apache-2.0 授权的 dm-rust 0.1.1。crates.io 原始压缩包 SHA-256 为 `5923be780c4a983beb4034ef9facf620236d532ed862aa923b97f58add5b5448`。本项目修改了证书验证、明文协商、网络字节及行数上限、文本解码和结束连接的处理，修改文件有标记。上游许可证随源码保留。[上游仓库](https://github.com/daxiangme/dm-rust) · [上游版本](https://crates.io/crates/dm-rust/0.1.1)
