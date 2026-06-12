# JLMS — 项目进度

> 一个类 [Surge](https://nssurge.com/) 的 macOS 规则代理客户端 · **Mihomo 内核 + Tauri 外壳**
> 更新于 **2026-06-11**

## 一句话现状

P0 地基与 P1 订阅系统已完成并**真机端到端验证**（用真实订阅加载了 118 节点 / 22 策略组）；
**Surge 风格浅色 UI** 的外壳 / 概览 / 策略 / 请求 / 流量 / 订阅 / 日志已落地，系统代理开关、出站模式持久化与概览摘要已接入；系统代理现优先作用于活跃网络服务，logo/icon 与应用名已切换为 JLMS，顶部窗口空白区域拖拽已修复，macOS 菜单栏托盘与退出清理已接入，当前进入 P1 收尾阶段。

---

## 架构速览

```
前端 (React+TS, Surge 浅色 UI)
   │ invoke 命令 / WebSocket 直连控制接口
Rust 后端 (Tauri)  ── 进程管理 · 生成配置 · 转发控制 API
   │ sidecar 子进程
mihomo 内核  ── 协议/规则/DNS/TUN · REST+WS @127.0.0.1:9090
```

详见 [README.md](README.md)。

---

## 进度总览

### ✅ 已完成

**P0 地基**
- [x] Tauri v2 + React 19 + TypeScript + Vite 脚手架
- [x] mihomo v1.19.27 内核作为 sidecar 打包（`src-tauri/binaries/`）
- [x] 内核进程管理：启动 / 停止 / 重启，退出自清理（`engine/manager.rs`）
- [x] 内核日志转发到前端（`core://log` 事件）
- [x] 随机控制密钥，持久化（`controller-secret`）
- [x] 开机自动拉起内核 + 加载上次激活订阅
- [x] 真机验证：Tauri → 拉起 sidecar → 控制 API 鉴权可用

**P1 订阅系统**
- [x] 订阅模型与持久化（`index.json` + `<id>.yaml`，`engine/profiles.rs`）
- [x] URL 导入（`clash.meta` UA，避开机场按 UA 返回 Surge 格式的坑）
- [x] 本地文件导入（`@tauri-apps/plugin-dialog` 文件选择）
- [x] 启用 / 更新（重新拉取）/ 删除
- [x] 配置生成：以激活订阅为基础，**强制盖上控制面参数**（`engine/config.rs`）
- [x] 配置热重载（`PUT /configs`，不杀进程）

**P1 控制 API（后端已就绪）**
- [x] 策略组列表 `GET /proxies`
- [x] 切换节点 `PUT /proxies/{group}`
- [x] 延迟测试 `GET /proxies/{name}/delay`
- [x] 出站模式 `PATCH /configs`（直连 / 全局 / 规则）
- [x] 出站模式持久化（`settings.json`，启动恢复上次模式）
- [x] 控制器信息（地址 + 密钥）暴露给前端开 WebSocket

**P1 前端 UI（Surge 浅色）**
- [x] 侧边栏 shell：概览 / 策略 / 请求 / 流量 / 订阅 / 日志（lucide 线性图标）
- [x] macOS **Overlay 标题栏**（交通灯叠在侧栏顶部，边到边）
- [x] 窗口拖拽区修复（顶部空白区域可拖动，模式切换按钮保持可点击）
- [x] 左侧激活菜单项 hover 样式修复（避免被全局按钮 hover 覆盖成浅底）
- [x] macOS 菜单栏托盘（常驻 icon + 原生菜单，可显示主窗口 / 切换出站模式 / 开关系统代理 / 退出）
- [x] 托盘策略组菜单（动态读取 Mihomo 策略组与节点列表，可直接在菜单栏切换当前节点）
- [x] 托盘策略增强（常用策略组直出，其余折叠到 More；节点支持托盘测速、延迟值和彩色延迟标记）
- [x] 托盘状态增强（Connectivity Quality、Top Clients、Dashboard... 入口）
- [x] 托盘 Top Clients 改为近实时速率（基于周期采样差值展示 `B/s`）
- [x] 品牌切换为 JLMS（应用内 logo、bundle icon、窗口标题、托盘 tooltip）
- [x] 托盘图标单独切到 `icon2.png`，不再复用 app / Dock 图标
- [x] Dock / 构建 app 图标改为圆角源图重新生成（`icon.icns` / `icon.png` / `128x128.png` 已确认圆角）
- [x] 修复托盘周期刷新崩溃（后台线程不再直接改 tray menu，统一切回主线程刷新）
- [x] Rust 包名 / 可执行产物 / bundle identifier 切到 `jlms`，消除系统层残留的 `fk_surge`
- [x] 启动时自动迁移旧运行时数据目录（`com.fksurge.desktop` → `com.jlms.desktop`），避免改名后订阅/设置“丢失”
- [x] 订阅读取增加旧目录回退（即使迁移未触发，也能直接读到 `com.fksurge.desktop` 中的历史订阅）
- [x] 策略页对空 `proxies` 响应增加保护，修复 `Object.entries requires that input parameter not be null or undefined`
- [x] 托盘图标改为用户提供的 `icon_white.png`，并恢复为透明边界自适应裁切；单色图标走 macOS template 模式以适配明暗菜单栏
- [x] 托盘 icon 改为非模板原图，并按透明边界自动裁切缩放，更接近 `icon2.png` 的实际显示效果
- [x] 调整 app icon 构图（缩进圆角底板、收窄白边、放大主图），修复 Dock 中图案过小和整体偏大的观感
- [x] 托盘 icon 改为专用固定裁切框（针对 `icon2.png` 主体区域缩放），修复四周留白过宽导致的顶部图标过小
- [x] UI 第一轮向 Surge 看齐：侧栏改为分组导航、顶部加入信息胶囊与状态胶囊、窗口整体改为浅色悬浮面板风格
- [x] 概览页重构为 Surge 风格 Activity 面板：摘要信息行、Latency / Upload / Download / Active Connection / Traffic / Policies / Top Requests 卡片
- [x] Policy 页第二轮改版：增加 Surge 风格摘要卡、诊断操作区与更高密度的策略组面板
- [x] Process / Requests 页第二轮改版：增加连接摘要卡、总流量摘要与更紧凑的连接卡片列表
- [x] Profile 页第二轮改版：增加导入面板、当前激活配置卡与更接近 Surge 的订阅管理布局
- [x] Traffic 页第三轮改版：增加实时速率摘要卡、Surge 风格主图表外壳、统计卡与最近采样卡
- [x] Logs 页第三轮改版：增加页头状态信息与深色 Runtime Console 样式
- [x] 侧栏底部与全局视觉细节第三轮收口：补足底部层次、卡片圆角与页面间一致性
- [x] UI 第四轮减法收口：移除多余右上角徽标、压缩顶部状态条、统一卡片阴影/圆角/密度，修复“样式很乱”的整体观感
- [x] 去掉侧栏底部占位入口 `More / Dashboard`，仅保留真实可用功能导航与运行状态
- [x] 滚动条改为悬浮式透明轨道 + 细 thumb，减弱右侧滚动槽的视觉存在感
- [x] 修正对 Surge 截图的误判：去掉“桌面壁纸式”双层壳背景，恢复单层应用窗口结构
- [x] 去掉右侧内容区页标题（如 `Activity / Overview`），内容直接从功能面板开始
- [x] 页面标题移回顶部工具栏左侧，替换原来的 `JLMS / Mihomo vX` 文案，右侧内容区不再重复显示标题
- [x] 顶部页面标题进一步收口：去掉分类标签，仅保留页面名本身
- [x] 重排 `Process / Policy / Profile` 顶部区域：改用更克制的摘要指标行、工具栏和更紧凑的卡片比例，修复后几页“有点丑”的块状布局
- [x] 继续细抠 `Process / Policy / Profile`：统一按钮尺寸、压缩卡片/列表行高、收紧节点 chip 与配置操作区，减少网页卡片感并提升桌面工具密度
- [x] 单独精修 `Profile`：顶部导入/当前配置面板改为更薄的工具面板，列表行改成更像原生配置条目，收紧激活态与操作按钮
- [x] `Overview` 第四轮对齐 Surge Activity：改成更接近真机截图的三行卡片布局（Latency / Upload / Download / Active Connection / Traffic / Total Traffic / Content）
- [x] `Overview` 右下区域继续对齐 Surge：把拆开的 `Traffic` 与 `Content` 两块合并为单张大卡，改成上图表下标签/内容列表的结构
- [x] `Overview` 外层布局继续对齐 Surge：改成左右等宽双列，左列为 `Latency / Active Connection / Total Traffic`，右列为 `Upload / Download / Traffic`
- [x] `Overview` 的 `Total Traffic` 卡片继续按 Surge 收口：去掉说明文案，改成底部 `Direct / Proxy` 双端数值 + 更厚的彩色进度条
- [x] `Overview` 卡片继续收对齐：锁定第一排统一高度，并让右侧 `Traffic` 大卡高度精确等于左侧后两张卡加间距，修复上下边线不齐
- [x] `Overview` 改为随窗口高度自适应：卡片高度、图表区和间距改用 `clamp(...)` 收缩，避免主内容挤占一整屏导致下方“系统”区域被推出视口
- [x] 回退 `Overview` 上一版会压坏布局的“整页强行一屏”方案，恢复正常卡片骨架；仅保留右下 `Traffic` 卡内部列表单独滚动，避免内容增多时继续把整页往下撑
- [x] 按最新 UI 反馈回退 `Overview` 的强制一屏方案：恢复正常纵向文档流，仅保留“第一行卡片对齐”和“`Traffic` 卡内部列表单独滚动”，系统区允许自然被往下推
- [x] `Overview` 继续小修：第一行卡片改成明确同高，恢复 `Traffic` 卡稳定高度约束并让列表区在卡内滚动，避免有内容时再次把右下卡整体撑高
- [x] `Overview` 第一个卡片信息区改按 Surge 重排：去掉中间说明文案，改成底部 `Router / DNS / 当前节点延迟` 三列结构
- [x] `Overview` 的 `Internet Latency` 卡片语义改正：不再显示“延迟最低策略组”的当前节点，而是按当前出站模式解析全局默认出口（`rule` 取最终 `MATCH` 规则目标，`global` 取 `GLOBAL`，`direct` 取 `DIRECT`）；若命中的是策略组，还会沿着 `now` 继续追到最终叶子节点，再展示真实默认出口节点与对应延迟
- [x] `Overview` 的 `Internet Latency` 卡片补齐 `Router / DNS` 真实诊断：后端新增 macOS 网络诊断接口，按默认网关 `ping` 取 `Router` RTT，并按活跃网络服务的 DNS 服务器执行真实 `dig` 查询取 `DNS` 耗时；前端卡片改为自动拉取并支持点击 `Diagnostics` 手动重测
- [x] `Internet Latency` 详情浮层已接入：从卡片右上角可查看默认网关 IP、DNS Server、默认出口链路与最近一次测量时间，并支持在浮层内再次重测
- [x] `Overview` 底边对齐修正思路调整：撤回对左侧 `Active Connection / Total Traffic` 的硬高度限制，改为仅微调右侧 `Traffic` 大卡高度，避免破坏其他卡片内容展示
- [x] `Overview` 右侧 `Traffic` 大卡高度补偿继续上调，用于追齐左侧两张卡叠加后的底边，且不再动左侧卡片高度
- [x] `tauri dev` 交互卡顿专项优化：`dev` 下关闭 `React.StrictMode` 双重执行、日志订阅仅在 `Logs` 页激活、顶栏状态轮询降频且值未变化时不再触发整树重渲染
- [x] 清理本轮开发警告：移除 `lib.rs` 中无用 `mut` 与 `system_proxy.rs` 中未使用函数，降低 `cargo run` 启动噪声
- [x] 侧栏品牌图改回轻量 `SVG`，替代 2MB 级 PNG 资源，减少 `dev` 模式前端资源开销
- [x] 全局性能第一轮梳理：移除托盘菜单每 2 秒整棵重建的后台循环，改为事件驱动刷新，修复托盘菜单弹出后数秒自动消失的主要根因
- [x] 托盘菜单刷新去抖：连续触发的 tray sync 只合并为一次主线程菜单重建，避免模式切换/测速/策略切换时重复刷新菜单
- [x] 前端实时流统一加节流：`Overview / Requests / Traffic` 的 WebSocket 消息改为按 250-500ms 批量投递，降低高频消息直接触发 React 重渲染的开销
- [x] `Policy` 页继续收口：压缩顶部第一行指标卡高度，减少卡底空白；同时去掉策略组列表之间的纵向间距并略缩组头 padding
- [x] `Policy` 页节点卡片样式继续优化：节点条目改成更稳的单行胶囊卡，激活态边框/底色更克制，延迟值改为更统一的状态标签
- [x] `Policy` 节点卡进一步精修：把“当前节点”从第二行说明改成名称旁微标记，统一卡片高度与信息节奏，并细化边框渐变、内高光和延迟胶囊质感
- [x] 修复策略组选择重启后丢失：不再只依赖 Mihomo 的 `store-selected`，而是按“激活订阅 ID + 策略组名”把当前节点写入 `settings.json`，并在配置重载、切换订阅和应用启动后主动恢复这些选择
- [x] 补齐策略组恢复时序：启动/重启后恢复节点选择前先等待 Mihomo controller 的 `/proxies` 就绪，避免在 `127.0.0.1:9090` 尚未监听时过早回放选择导致恢复失败
- [x] 修正 `Overview` 的 `NETWORK` 取值：不再直接显示第一个命中的代理服务，而是优先显示当前活跃网络服务对应的代理 service，避免 Wi-Fi 场景下误显示成 `CDC Device`
- [x] `Overview` 的 `NETWORK` 继续改为更友好的网络类型显示：后端补充返回主网络服务对应的 `hardware port`，前端优先把 `Wi‑Fi / Ethernet` 等硬件端口名格式化为 Surge 风格标签，并对 `CDC Device` 做兜底清洗
- [x] 补全 `Overview` 底部两张卡的 tab 逻辑：`Total Traffic` 的 `TODAY / MONTH` 接上本地持久化统计，`Traffic` 的 `ALL / PROXY` 与 `CLIENT / DOMAIN / POLICY` 接上真实过滤与聚合
- [x] 继续精修 `Overview`：右侧 `Traffic` 大卡高度进一步回收，减少比左侧两张卡叠加更长的问题；右上 `Upload / Download` 小图改为前端插值动画，更新时更接近平滑向左滚动
- [x] `Overview` 小图继续收向真机滚动感：撤掉带缓动的整线插值，改成固定步长的双路径线性左移；同时把 `traffic` 采样节奏提高到 160ms，减少“一卡一卡推动”的观感
- [x] 修正 `Overview` 小图双线 bug：撤回双路径同时可见的渲染方式，改回单路径线性插值，避免折线叠出两条可见轨迹
- [x] `Overview` 小图继续改成真正单线左滚：改为“扩展序列 + 单路径裁切窗口”方案，让折线在视口内连续向左滑动，同时保持全程只有一条可见轨迹
- [x] `Overview` 小图继续去掉“秒针感”：把图表推进时钟从数据到达节奏里拆出来，改成独立 `requestAnimationFrame` 连续滚动；流量值只负责填充右侧新点，不再直接决定每次位移时机
- [x] 继续精修 `Overview` 小图观感：图表改成 `pathRef` 直写的连续 RAF 更新，减少 React 每帧状态更新带来的偶发卡顿；同时让 `Upload / Download` 卡底部 chart 做到更接近贴边满宽
- [x] 侧栏品牌图改回用户确认的项目 logo：不再使用旧的条形 `logo-mark.svg`，改为应用图标同源的杯子熊猫图，并作为 `sidebar-logo.png` 供左侧品牌位使用
- [x] 侧栏品牌图进一步修正为高清资源：直接改用 `src-tauri/icons/icon.png` 作为前端侧栏 logo 来源，避免低分辨率导出导致的图标过小、失真和毛边问题
- [x] 根层状态轮询继续降频：`App` 顶部状态轮询从 4 秒放宽到 10 秒，仍保留可见时刷新与聚焦刷新
- [x] `Profile` 页继续美化：列表外层改为更克制的原生分组容器，条目 hover/激活态收紧为轻底色 + 左侧细强调线
- [x] `Profile` 条目信息层级继续收口：类型改成更轻的胶囊标签，订阅 URL 以单行来源条展示，整体更像桌面配置列表而不是散装卡片
- [x] `Profile` 顶部导入区继续简化：去掉说明型头部，改成更薄的单行导入工具条，仅保留小标签、输入框和两个操作按钮
- [x] 新增全局主题切换：顶栏加入 `亮色 / 暗色` 主题按钮，主题选择写入本地持久化；同时补齐壳层、卡片、分段控件、按钮、Profile/Policy/Overview 关键组件的暗色配色覆盖
- [x] 主题设置继续收口：顶栏移除低频主题切换，改为在 `System` 分组下新增 `Settings` 页面承载 `跟随系统 / 亮色 / 暗色` 主题偏好，避免顶部工具区拥挤
- [x] 暂时移除 `Device` 页面入口：从侧栏导航和主内容切换中去掉独立 `Device` 视图，避免当前信息架构继续发散
- [x] `Profile` 去掉顶部“当前配置”卡片，仅保留单行导入面板与更紧凑的配置列表
- [x] 全局样式继续向 Surge 收口：降低卡片圆角与阴影、压平顶栏和分段控件、统一更偏桌面工具的浅灰基底
- [x] 尝试直接捕获本机 Surge 窗口用于对照，但当前环境未返回可用窗口截图输出；本轮仍以用户提供截图为准继续精修
- [x] 已成功捕获本机运行中的 Surge 与 JLMS 窗口做真机对照，并据此继续微调标题层级、卡片圆角/阴影与 Overview 的 Upload/Download 折线表现
- [x] 关闭主窗口时隐藏到菜单栏，避免误关后直接退出
- [x] 退出前清理系统代理并停止内核，避免残留代理设置影响系统网络
- [x] **概览页**：实时流量四卡片（WebSocket `/traffic`、`/connections`）+ 内核信息 + 策略摘要 + 关键请求概览
- [x] **出站模式分段控件**（接真实控制 API）
- [x] **系统代理开关**：查询当前状态，并通过 `networksetup` 设置 HTTP / HTTPS / SOCKS 系统代理
- [x] **策略页**：策略组列表、节点切换、单组/全量测速、延迟色块
- [x] **请求页**：实时连接列表、搜索过滤、规则命中 / 链路 / 进程展示
- [x] **流量页**：实时上下行曲线、最近 60 个采样点、峰值 / 平均值 / 最近采样
- [x] **订阅页**：导入 URL / 本地文件 / 启用 / 更新 / 删除
- [x] **日志页**：内核实时日志
- [x] App logo / bundle icon 替换为新品牌图形（SVG + Tauri icon 集）

**环境**
- [x] rustup stable 1.96（homebrew rust 1.79 太旧，已 `brew unlink`）
- [x] USTC crates 镜像（`.cargo/config.toml`，解决 crates.io 卡顿）

### 🚧 部分完成 / 待接线

- [ ] **系统开关**：TUN / MitM 仍是占位；系统代理已接入，待更多真机场景验证

### ⬜ 未开始

- [ ] 规则页（查看 / 编辑规则、规则集订阅、命中测试）
- [ ] TUN 系统级接管（P3）
- [ ] MitM 抓包（v1 之后）
- [ ] 脚本 / 模块、菜单栏面板、托盘常驻、移动端

---

## 已知问题 / 技术债

| # | 问题 | 影响 | 计划 |
|---|------|------|------|
| 1 | 订阅**仅支持 Clash 格式**，base64/SS-style 链接未转换 | 部分机场链接导入失败 | 后续加转换 |
| 2 | geo 数据库首次运行自动下载 | 依赖网络，首启略慢 | 可选：内置 geo 数据 |
| 3 | 无单元 / 集成测试 | — | 关键模块补测试 |
| 4 | **系统代理启用时在未识别活跃服务时仍会回退到全服务设置** | 某些非常规网络环境下仍可能需要更细粒度控制 | 后续可细化为用户可选服务 |
| 5 | macOS Dock / Finder 图标可能继续显示旧缓存 | 视觉验证容易误判为图标未生效 | 重装新 `.app` 后执行 `killall Dock` |

---

## 路线图

### 立即（当前批次）
1. **规则页预研** — 梳理 mihomo 当前可暴露的规则信息与命中测试能力
2. **规则页接口补齐** — 评估是否需要新增后端命令面
3. **系统代理可选服务** — 在 UI 中允许选择或覆盖代理作用服务

### P1 收尾
4. 系统代理更多真机场景验证

### P2 规则分流
7. 规则页（规则 / 规则集管理、命中测试）

### P3 TUN
8. 特权 helper 提权 + 虚拟网卡全局接管 + fake-ip DNS

### v1 之后
9. MitM 抓包、脚本 / 模块、菜单栏面板、托盘、暗色主题、移动端

---

## 关键文件 / 模块

```
src/                         前端
  App.tsx                    侧边栏 shell + 出站模式 + 路由
  Overview.tsx               概览页（实时流量 + 策略摘要 + 关键请求）
  Profiles.tsx               订阅页
  assets/logo-mark.svg       应用内 logo 源文件
  api.ts                     invoke 命令封装 + 类型
  ws.ts                      mihomo WebSocket 流助手
  App.css                    macOS 浅色主题
src-tauri/
  binaries/mihomo-*          内核 sidecar
  src/
    lib.rs                   Tauri 入口：插件 / 命令 / 开机自启
    commands.rs              暴露给前端的命令
    paths.rs                 数据目录布局
    util.rs                  随机/时间小工具
    engine/
      config.rs              生成 mihomo 配置（订阅为基础 + 控制面覆盖）
      manager.rs             内核进程管理
      api.rs                 控制接口 REST 客户端
      profiles.rs            订阅导入 / 管理
      settings.rs            设置持久化（当前保存出站模式）
      system_proxy.rs        系统代理查询 / 设置 / 活跃网络服务识别
  tauri.conf.json            externalBin、Overlay 标题栏
.cargo/config.toml           USTC crates 镜像
scripts/generate_icons.py    备用图标生成脚本（当前正式使用 Tauri icon 生成）
```

运行时数据：`~/Library/Application Support/com.jlms.desktop/`
（首次启动会自动从旧目录 `~/Library/Application Support/com.fksurge.desktop/` 迁移 `config.yaml`、`controller-secret`、`settings.json`、`profiles/` 与内核缓存）。

---

## 如何运行

前置：Node ≥ 20、rustup stable（**不要用 homebrew 的旧 rust**）、Xcode CLT。

```bash
cd /Users/hwh/apps/fk_surge
npm install
npm run tauri dev      # 开发模式（热更新）
npm run tauri build    # 打包 .app / .dmg
```

> 工具链备注：本机此前是 homebrew rust 1.79（太旧），已装 rustup stable 1.96 并
> `brew unlink rust`，使 `cargo`/`rustc` 默认走 rustup。如需还原：`brew link rust`。
