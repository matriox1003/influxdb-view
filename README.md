# InfluxDB View

<div align="center">

[![中文](https://img.shields.io/badge/语言-简体中文-blue)](#中文文档)
[![English](https://img.shields.io/badge/Language-English-green)](#english-documentation)

一个 InfluxDB **1.x** 的桌面客户端，体验类似 Navicat。基于 Electron + React + Mantine UI 构建。

A desktop client for InfluxDB **1.x** with a Navicat-like experience. Built with Electron + React + Mantine UI.

![tech](https://img.shields.io/badge/Electron-31-blue) ![tech](https://img.shields.io/badge/React-19-61dafb) ![tech](https://img.shields.io/badge/Mantine_UI-7-3347b3)

[![Build Windows](https://github.com/matriox1003/influxdb-view/actions/workflows/build-windows.yml/badge.svg)](https://github.com/matriox1003/influxdb-view/actions/workflows/build-windows.yml)

</div>

---

<a id="中文文档"></a>

## 中文文档

### 功能特性

- **连接管理**：新建 / 编辑 / 删除 / 测试连接，支持多连接切换。密码使用 Electron `safeStorage` 系统级加密存储。
- **对象树浏览**：左侧树形展示 `数据库 → 测量值(Measurement) → 字段 / 标签`，右键可生成 `SELECT` / `COUNT` 语句。
- **InfluxQL 查询**：CodeMirror 6 编辑器（SQL 语法高亮、行号、撤销重做），`Ctrl/Cmd + Enter` 执行；结果按 series 分标签页展示，时间列可在 **本地时间 / UTC** 间切换，显示执行耗时与行数。
- **结果导出**：查询结果一键导出为 **Excel（.xlsx）** 或 **JSON**，支持勾选行部分导出。
- **查询历史与收藏**：历史自动记录；常用查询可收藏（持久化写盘），随时调出重跑。
- **管理功能**：数据库（建/删）、保留策略 RP（查看）、连续查询 CQ（查看）、用户管理（建/删）。
- **数据写入**：支持 **类 SQL 语法**，底层自动转换为 Line Protocol 写入；也可直接写 Line Protocol，或导入 `.txt` / `.sql` / `.lp` / `.log` 文件，自动过滤注释行。
  ```sql
  -- 类 SQL 写法（自动转 Line Protocol）
  INSERT INTO cpu(host=s1, region=us) value=0.64, temp=45
  ```
- **界面**：自定义无边框标题栏（macOS 保留红绿灯按钮）、亮色 / 暗色 / 跟随系统三态主题并持久化。
- **自动更新**：基于 GitHub Releases（electron-updater），启动时静默检查，顶栏可手动检查、下载（带进度）并一键安装。
- **安全**：渲染层关闭 `nodeIntegration`、开启 `contextIsolation`，仅通过 preload 白名单 IPC 访问 Node 能力；所有 InfluxDB 请求在主进程发起，规避浏览器 CORS。

### 快速开始

#### 环境要求

- Node.js ≥ 18（开发环境使用 Node 22 验证）
- pnpm ≥ 11（`setup` 脚本与 `pnpm-workspace.yaml` 构建权限配置依赖 pnpm）

#### 安装依赖

```bash
pnpm run setup
```

> `setup` 会通过 dotenv-cli 读取 `.env` 中的镜像变量再执行安装，国内网络无需额外配置即可正常下载 Electron 二进制。注意必须写成 `pnpm run setup`——`pnpm setup` 是 pnpm 的内建全局命令，不会执行本项目脚本：
> ```bash
> # .env（已包含在仓库中）
> ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
> ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
> ```

#### 开发模式

```bash
pnpm dev
```

会同时启动 Vite 开发服务器（`http://localhost:5173`）和 Electron 窗口，支持渲染层热更新。

> 修改 `electron/` 下的主进程代码需要重启 `pnpm dev` 才会生效。

#### 连接到 InfluxDB

1. 启动一个 InfluxDB 1.x 实例（例如本地 `http://localhost:8086`）。
2. 应用顶部点击 **+** 新建连接，填写名称 / 主机 / 端口 / 凭据，可先点 **测试连接**。
3. 保存后在顶部下拉选择该连接，左侧对象树会自动加载数据库。
4. 点击工作区 **+** 打开查询页，编写 InfluxQL 后按 `Ctrl+Enter` 执行。

### 打包

```bash
# 完整构建（编译主进程 + 渲染层）并打包成 Windows 安装包
pnpm package:win
```

脚本内部同样通过 dotenv-cli 注入 `.env` 镜像（electron-builder 工具链下载加速），产物输出到 `dist-release/` 目录（nsis 安装程序 + portable 便携版），已关闭 Windows 代码签名。

### 项目结构

```
influxdb-view/
├── electron/                  # 主进程（TypeScript → dist-electron）
│   ├── main.ts                # 窗口、生命周期、IPC 注册
│   ├── preload.ts             # contextBridge 安全暴露 API
│   ├── types.ts               # 主/渲染共享类型
│   └── ipc/
│       ├── connection.ts      # 连接 CRUD + safeStorage 加密
│       └── influx.ts          # InfluxDB HTTP 客户端（ping/query/write）+ 收藏查询持久化
├── src/                       # 渲染进程（React）
│   ├── main.tsx               # 入口
│   ├── App.tsx                # 整体布局
│   ├── theme.ts               # Mantine 主题定制
│   ├── store/                 # Zustand 状态管理
│   ├── components/
│   │   ├── ConnectionBar/     # 顶栏：连接管理 + 主题切换
│   │   ├── Sidebar/           # 左侧对象树
│   │   ├── Workspace/         # 工作区多标签容器
│   │   ├── QueryEditor/       # 查询编辑器 + 结果表 + 历史 + 收藏
│   │   ├── AdminPanel/        # 数据库/RP/CQ/用户管理
│   │   ├── DataManager/       # 数据写入（类 SQL → Line Protocol）
│   │   ├── TitleBar.tsx       # 自定义无边框标题栏
│   │   ├── ContextMenu.tsx    # 通用右键菜单
│   │   ├── ErrorDialog.tsx    # 错误提示弹窗
│   │   └── ThemeProvider.tsx
│   ├── utils/
│   │   ├── exporter.ts        # 结果导出（xlsx / json，Worker 调度）
│   │   ├── xlsx.worker.ts     # xlsx 生成 Web Worker
│   │   └── format.ts          # 时间/单元格格式化
│   └── styles/global.css
├── vite.config.mts
├── electron-builder 配置（package.json 的 build 字段）
└── package.json
```

### 技术栈

| 层 | 选型 |
|----|------|
| 桌面框架 | Electron 31 + electron-builder |
| 构建 | Vite 5（渲染）+ tsc（主进程） |
| UI | React 19 + Mantine UI 7（mantine-react-table + Tabler Icons） |
| 状态 | Zustand |
| 编辑器 | CodeMirror 6（@codemirror/lang-sql） |
| 导出 | SheetJS（xlsx，Web Worker 后台生成，主线程回退） |
| 通信 | InfluxDB 1.x HTTP API（`/ping` `/query` `/write`），Node http/https 模块 |

### 常见问题

**Q：为什么查询时要选数据库？**  
InfluxDB 1.x HTTP API 不支持 `USE` 语句，目标库必须通过 `?db=` 参数指定。下拉选择会调用 `SHOW DATABASES` 自动填充；也可使用连接配置里的"默认数据库"。

**Q：时间显示为什么不是纳秒？**  
为便于阅读，时间列（RFC3339 或大数字 epoch）会被自动转换为可读时间字符串，支持本地 / UTC 一键切换；导出文件与表格显示保持一致。

**Q：写入数据必须学 Line Protocol 吗？**  
不必。数据写入页支持类 SQL 语法（`INSERT INTO cpu(host=s1) value=0.64`），保存时自动转换为 Line Protocol；转换失败的行会逐行提示原因。

---

<a id="english-documentation"></a>

## English Documentation

### Features

- **Connection Management**: Create / edit / delete / test connections with multi-connection switching. Passwords are stored with system-level encryption via Electron `safeStorage`.
- **Object Tree**: Left-side tree view of `Database → Measurement → Fields / Tags`; right-click to generate `SELECT` / `COUNT` statements.
- **InfluxQL Querying**: CodeMirror 6 editor (SQL syntax highlighting, line numbers, undo/redo), execute with `Ctrl/Cmd + Enter`; results grouped in tabs per series, time column switchable between **local time / UTC**, with elapsed time and row count.
- **Result Export**: One-click export of query results to **Excel (.xlsx)** or **JSON**, with partial export of selected rows.
- **History & Favorites**: Queries are recorded automatically; frequently used queries can be favorited (persisted to disk) and re-run anytime.
- **Administration**: Databases (create/drop), Retention Policies (view), Continuous Queries (view), user management (create/drop).
- **Data Writing**: Supports a **SQL-like syntax** automatically converted to Line Protocol; raw Line Protocol is also accepted, as well as importing `.txt` / `.sql` / `.lp` / `.log` files with comment lines filtered out.
  ```sql
  -- SQL-like syntax (auto-converted to Line Protocol)
  INSERT INTO cpu(host=s1, region=us) value=0.64, temp=45
  ```
- **UI**: Custom frameless title bar (traffic lights preserved on macOS), light / dark / system-follow theme with persistence.
- **Auto Update**: Silent update checks on startup via GitHub Releases (electron-updater); manual check, download with progress, and one-click install from the top bar.
- **Security**: `nodeIntegration` disabled and `contextIsolation` enabled in the renderer; Node capabilities are only accessible via a whitelisted preload IPC. All InfluxDB requests are made from the main process, bypassing browser CORS.

### Getting Started

#### Prerequisites

- Node.js ≥ 18 (developed and verified on Node 22)
- pnpm ≥ 11 (required by the `setup` script and the `pnpm-workspace.yaml` build-permission config)

#### Install Dependencies

```bash
pnpm run setup
```

> `setup` reads mirror variables from `.env` via dotenv-cli before installing, so the Electron binary downloads normally on networks in China without extra configuration. Note it must be `pnpm run setup` — bare `pnpm setup` is pnpm's built-in global command and will NOT run the project script:
> ```bash
> # .env (already included in the repo)
> ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
> ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
> ```

#### Development

```bash
pnpm dev
```

Starts both the Vite dev server (`http://localhost:5173`) and the Electron window, with hot reload for the renderer.

> Changes under `electron/` (main process) require restarting `pnpm dev` to take effect.

#### Connect to InfluxDB

1. Start an InfluxDB 1.x instance (e.g. `http://localhost:8086`).
2. Click **+** at the top of the app to create a connection, fill in name / host / port / credentials, optionally **Test Connection** first.
3. After saving, select the connection from the top dropdown; the object tree loads databases automatically.
4. Click **+** in the workspace to open a query tab, write InfluxQL and press `Ctrl+Enter` to execute.

### Packaging

```bash
# Full build (main process + renderer) and package as a Windows installer
pnpm package:win
```

The script also injects `.env` mirrors via dotenv-cli (accelerates electron-builder toolchain downloads). Artifacts are output to `dist-release/` (NSIS installer + portable), with Windows code signing disabled.

### Project Structure

```
influxdb-view/
├── electron/                  # Main process (TypeScript → dist-electron)
│   ├── main.ts                # Window, lifecycle, IPC registration
│   ├── preload.ts             # Secure API exposure via contextBridge
│   ├── types.ts               # Shared main/renderer types
│   └── ipc/
│       ├── connection.ts      # Connection CRUD + safeStorage encryption
│       └── influx.ts          # InfluxDB HTTP client (ping/query/write) + saved-query persistence
├── src/                       # Renderer process (React)
│   ├── main.tsx               # Entry
│   ├── App.tsx                # Overall layout
│   ├── theme.ts               # Mantine theme customization
│   ├── store/                 # Zustand state management
│   ├── components/
│   │   ├── ConnectionBar/     # Top bar: connections + theme switch
│   │   ├── Sidebar/           # Left object tree
│   │   ├── Workspace/         # Multi-tab workspace
│   │   ├── QueryEditor/       # Query editor + result table + history + favorites
│   │   ├── AdminPanel/        # DB/RP/CQ/user administration
│   │   ├── DataManager/       # Data writing (SQL-like → Line Protocol)
│   │   ├── TitleBar.tsx       # Custom frameless title bar
│   │   ├── ContextMenu.tsx    # Generic context menu
│   │   ├── ErrorDialog.tsx    # Error dialog
│   │   └── ThemeProvider.tsx
│   ├── utils/
│   │   ├── exporter.ts        # Result export (xlsx / json, Worker dispatch)
│   │   ├── xlsx.worker.ts     # xlsx generation Web Worker
│   │   └── format.ts          # Time/cell formatting
│   └── styles/global.css
├── vite.config.mts
├── electron-builder config (build field in package.json)
└── package.json
```

### Tech Stack

| Layer | Choice |
|-------|--------|
| Desktop | Electron 31 + electron-builder |
| Build | Vite 5 (renderer) + tsc (main process) |
| UI | React 19 + Mantine UI 7 (mantine-react-table + Tabler Icons) |
| State | Zustand |
| Editor | CodeMirror 6 (@codemirror/lang-sql) |
| Export | SheetJS (xlsx, generated in a Web Worker with main-thread fallback) |
| Transport | InfluxDB 1.x HTTP API (`/ping` `/query` `/write`), Node http/https modules |

### FAQ

**Q: Why do I need to select a database when querying?**  
The InfluxDB 1.x HTTP API has no `USE` statement; the target database must be specified via the `?db=` parameter. The dropdown is auto-filled with `SHOW DATABASES`; you can also set a "default database" in the connection config.

**Q: Why isn't the time displayed in nanoseconds?**  
For readability, the time column (RFC3339 or large epoch numbers) is automatically converted to a human-readable string, with a one-click local / UTC toggle; exported files match the table display.

**Q: Do I have to learn Line Protocol to write data?**  
No. The data-writing page accepts SQL-like syntax (`INSERT INTO cpu(host=s1) value=0.64`) which is automatically converted to Line Protocol on save; failed conversions are reported line by line.

## License

MIT
