import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { PROGRESS_DIR_NAME } from './progress-window';

// 自定义标题栏：隐藏系统窗口边框，由渲染层自绘标题栏 + 拖拽区 + 控制按钮。
// Windows/Linux 用 frame:false；macOS 保留红绿灯按钮（更符合平台习惯）用 titleBarStyle。
const isMac = process.platform === 'darwin';

// 开发环境加载 Vite dev server，生产环境加载打包后的 index.html
const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;

// 开发环境使用独立的 userData 目录，避免与已安装版本/其他实例的缓存冲突（权限错误）
if (isDev) {
  app.setName('InfluxDB View (dev)');
  app.setPath('userData', path.join(app.getPath('appData'), 'influxdb-view-dev'));
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'InfluxDB View',
    backgroundColor: '#17191f',
    show: false,
    icon: path.join(__dirname, '../assets/icon.png'),
    // 隐藏系统标题栏，使用自绘标题栏。
    // Windows/Linux: frame:false 完全无边框；macOS: hiddenInset 保留红绿灯且内容下沉。
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    // Windows 11 上仍显示系统原生控制按钮（更稳定），设 autoHideMenuBar 省去菜单栏
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 最大化状态同步给渲染层（自绘标题栏的“最大化/还原”按钮需要据此切换图标）
  const sendMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaximized);
  mainWindow.on('unmaximize', sendMaximized);

  // 无边框菜单更接近 Navicat 体验，但保留系统菜单快捷键
  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    // 屏蔽 DevTools 中 Autofill 协议不可用的错误（Electron 不实现该域）
    mainWindow.webContents.on('devtools-opened', () => {
      const dwc = mainWindow?.webContents.devToolsWebContents;
      if (dwc) {
        dwc.executeJavaScript(`
          (function() {
            const _err = console.error;
            console.error = function(...args) {
              const msg = args.join(' ');
              if (msg.includes('Autofill')) return;
              _err.apply(console, args);
            };
          })();
        `).catch(() => {});
      }
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 内容渲染完成后才显示窗口，避免白屏/黑屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.maximize();
    // 更新收尾信号：主窗口真正可见时写标记文件（含 pid），
    // 安装进度进程轮询到它才置 100% 并关闭——精确对齐"窗口可见"而非"进程存在"
    try {
      require('fs').writeFileSync(
        path.join(app.getPath('userData'), 'update-window-ready.json'),
        JSON.stringify({ pid: process.pid, at: Date.now() }),
        'utf-8',
      );
    } catch {
      /* 信号写失败只影响进度窗收尾时机（兜底超时），不影响应用本体 */
    }
  });

  // 外部链接在系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 注册所有 IPC 处理器
function registerIpc(): void {
  // 这两个模块在编译后位于同目录
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./ipc/connection');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./ipc/influx');
  // 应用更新（electron-updater + GitHub Releases）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./ipc/updater').registerUpdaterIpc();

  // 窗口控制（供自绘标题栏按钮调用）
  ipcMain.on('window:minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
  ipcMain.handle('window:toggleMaximize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    }
    win.maximize();
    return true;
  });
  ipcMain.on('window:close', () => BrowserWindow.getFocusedWindow()?.close());
}

// 清理更新进度窗口在 %TEMP% 留下的完整应用目录副本（见
// electron/ipc/updater.ts 的 spawnInstallProgressWindow）。
// 首次尝试刻意推迟：新版 whenReady 时进度子进程往往还在运行（它要等本版
// ready-to-show 标记 + 900ms、或最晚 180s 兜底才退出），立即 rm 会删掉它
// 尚未加载的文件（竞态）或徒劳失败。35s 覆盖全部正常退出路径，之后重试兜底；
// 全部失败就留给下次启动（或系统存储感知回收）。
function cleanupUpdateProgressDir(): void {
  const temp = app.getPath('temp');
  const attempt = (n: number): void => {
    // 副本目录名带唯一后缀（见 updater.ts 的 progressAppDir），这里清理所有
    // 以 PROGRESS_DIR_NAME 开头的目录；被进程占用的 rm 会失败，留到下一步重试
    let dirs: string[] = [];
    try {
      dirs = fs
        .readdirSync(temp, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith(PROGRESS_DIR_NAME))
        .map((e) => path.join(temp, e.name));
    } catch {
      /* 读取失败忽略 */
    }
    if (dirs.length === 0) return;
    for (const dir of dirs) {
      // force:true：目录不存在不算错误（首次启动/从未更新过）
      fs.rm(dir, { recursive: true, force: true }, (err) => {
        if (err && n < 4) setTimeout(() => attempt(n + 1), 15_000).unref();
      });
    }
  };
  setTimeout(() => attempt(0), 35_000).unref();
}

app.whenReady().then(() => {
  // 更新进度窗口模式：以 --update-progress 再入（独立进程），只显示进度条
  if (process.argv.includes('--update-progress')) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./progress-window').runProgressWindow();
    return;
  }

  registerIpc();
  createWindow();
  cleanupUpdateProgressDir();

  // macOs 上重新激活应用时，若没有窗口则新建一个
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 生产环境隐藏默认菜单（开发保留方便调试）
if (!isDev) {
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
  });
}
