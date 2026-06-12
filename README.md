# JLMS

一个自研的、类 [Surge](https://nssurge.com/) 的规则代理客户端（macOS 起步）。
内核复用成熟的 [Mihomo (Clash.Meta)](https://github.com/MetaCubeX/mihomo)，外壳与
全部上层功能自研。

## 架构

```
┌────────────────────────── JLMS.app (Tauri) ──────────────────────────┐
│  前端 (React + TS + Vite)        │  Rust 后端                          │
│  · 仪表盘 / 节点 / 规则 / 日志    │  · 进程生命周期 (启停/重启)         │
│  · 通过 invoke 调后端命令         │  · 生成 mihomo config.yaml          │
│  · 通过 WS 直连控制接口(后续)     │  · 通过控制 API 拿状态 / 切换 / 测速 │
└──────────────────────────────────┴──────────┬──────────────────────────┘
                                               │ sidecar 子进程 + 控制 API
                                       ┌───────▼─────────┐
                                       │ mihomo 内核      │
                                       │ 协议/规则/DNS/TUN │
                                       │ REST+WS :9090    │
                                       └──────────────────┘
```

- **内核**：`src-tauri/binaries/mihomo-aarch64-apple-darwin`，作为 Tauri sidecar 打包。
- **控制面**：Rust 后端拉起内核、生成配置，并通过其外部控制接口
  （`127.0.0.1:9090`，REST + WebSocket）获取实时数据、切换节点、测延迟。

## 目录结构

```
src/                         前端 (React)
  App.tsx                    P0 仪表盘
src-tauri/
  binaries/mihomo-*          内核二进制 (sidecar)
  src/
    lib.rs                   Tauri 入口：注册插件 / 命令 / 开机自启内核
    commands.rs              暴露给前端的命令 (core_start/stop/restart/status)
    paths.rs                 运行时数据目录布局
    engine/
      config.rs              生成 mihomo config.yaml
      manager.rs             内核进程管理 (spawn/kill + 日志转发)
      api.rs                 控制接口 REST 客户端
  tauri.conf.json            externalBin 声明内核 sidecar
```

运行时数据：`~/Library/Application Support/com.fksurge.desktop/`
（`config.yaml`、`controller-secret`、内核缓存等）。

## 开发与运行

前置：Node ≥ 20、Rust（较新的 stable）、Xcode CLT。

```bash
npm install
npm run tauri dev      # 开发模式，自动编译 Rust + 启动窗口
npm run tauri build    # 打包 .app / .dmg
```

启动后内核会自动拉起；仪表盘显示内核版本、混合端口与控制接口，可启停/重启内核。
系统代理走 `127.0.0.1:7890`（HTTP + SOCKS5 混合端口）。

## GitHub Actions 自动构建桌面包

仓库内已提供统一的桌面端自动构建工作流：

- 工作流文件：`.github/workflows/build-desktop.yml`
- 触发方式 1：在 GitHub Actions 页面手动运行 `Build Desktop Bundles`
- 触发方式 2：push 到 `main` 时自动构建
- 触发方式 3：push `v*` tag 时自动构建，并把产物上传到 GitHub Release

默认行为：

- 在 `windows-latest` runner 上构建 Windows x64
- 在 `macos-latest` runner 上构建 Apple Silicon macOS 包
- 在 `macos-13` runner 上构建 Intel macOS 包
- 自动从 `MetaCubeX/mihomo` release 下载对应平台的 `mihomo` sidecar
- 打包完成后上传平台产物到 workflow artifacts
- tag 构建时会把多平台产物一起上传到 GitHub Release

手动运行时可选输入：

- `mihomo_version`
  - 例如：`v1.19.27`
  - 留空时自动使用官方 latest release

## macOS 下载后提示 "damaged"

如果你下载 GitHub Actions 产出的 macOS 包后，打开时看到类似提示：

```text
"JLMS" is damaged and can't be opened. You should move it to the Trash.
```

这通常不是应用真的损坏了，而是 `macOS Gatekeeper` 对未签名 / 未公证、且带有浏览器下载隔离标记的应用进行了拦截。

常见原因：

- GitHub Actions 产物当前未做 Apple Developer 签名
- 也未做 notarization（公证）
- 通过 Chrome / Safari 下载后，文件会带上 `com.apple.quarantine` 标记

本地测试时可先手动移除隔离标记：

```bash
xattr -dr com.apple.quarantine /Applications/JLMS.app
```

如果应用还在下载目录，可按实际路径执行，例如：

```bash
xattr -dr com.apple.quarantine ~/Downloads/JLMS.app
```

如果移除隔离标记后仍无法打开，可继续执行以下命令查看系统校验结果：

```bash
spctl --assess --verbose=4 /Applications/JLMS.app
codesign --verify --deep --strict --verbose=2 /Applications/JLMS.app
```

说明：

- 本地自行构建的包通常不会因为浏览器下载而自动带上隔离标记
- GitHub Actions 下载产物更容易遇到这个问题
- 这是分发链路问题，不一定代表应用本身已损坏

正式分发时，推荐补齐以下步骤：

- Developer ID Application 签名
- 对内嵌 sidecar 一并签名
- notarization 公证
- staple 公证票据

## Windows 系统代理说明

Windows 平台本身支持系统代理，但如果你使用的是较早构建的测试包，可能会看到类似提示：

```text
system proxy is only supported on macOS
```

这不表示 Windows 系统不支持代理，而是当时的 JLMS 版本尚未实现 Windows 的系统代理控制逻辑。

后续版本将改为：

- 在 Windows 上直接读写系统代理设置
- 前端提示文案改为更准确的跨平台说明

## 路线图

- **P0 脚手架** — Tauri 骨架 + 内核 sidecar 管理 + 状态仪表盘 ← 进行中
- **P1 代理 + 仪表盘** — 订阅导入 / 手动节点、策略组切换、测延迟、实时流量/日志/连接、系统代理开关
- **P2 规则分流** — 规则 / 规则集管理、命中测试
- **P3 TUN** — 特权 helper 提权、虚拟网卡全局接管
- *(v1 之后)* — MITM 抓包、脚本 / 模块、移动端

## License

MIT
