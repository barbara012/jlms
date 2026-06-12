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

## 路线图

- **P0 脚手架** — Tauri 骨架 + 内核 sidecar 管理 + 状态仪表盘 ← 进行中
- **P1 代理 + 仪表盘** — 订阅导入 / 手动节点、策略组切换、测延迟、实时流量/日志/连接、系统代理开关
- **P2 规则分流** — 规则 / 规则集管理、命中测试
- **P3 TUN** — 特权 helper 提权、虚拟网卡全局接管
- *(v1 之后)* — MITM 抓包、脚本 / 模块、移动端
