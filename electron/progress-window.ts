/**
 * 更新进度窗口：以独立 Electron 进程运行（`--update-progress` 启动参数）。
 *
 * 由主应用在 quitAndInstall 前 spawn。注意它并非直接启动安装目录里的应用
 * exe，而是启动「%TEMP% 下完整应用目录副本」里的 exe（文件名也不同）：
 * 1) NSIS 静默安装器会按映像名 taskkill 主应用同名进程——名字不同才杀不到；
 * 2) 运行中的 Electron 会锁死安装目录里的 icudtl.dat / v8_context_snapshot.bin
 *    等文件（实测：不可重命名），而旧卸载器更新时必须把安装目录每个文件
 *    rename 走——撞上即 Abort 退出码 2，弹
 *    "Failed to uninstall old application files .: 2"。
 *    从 %TEMP% 副本启动后进程与安装目录零句柄关联，两个问题同时规避。
 * 详见 electron/ipc/updater.ts 的 spawnInstallProgressWindow。
 *
 * 进程独立，主应用退出后继续存活，覆盖真正的静默安装时段，直到新版启动自动退出。
 *
 * 相比 PowerShell/mshta/Win32 方案的优势：Chromium 渲染、样式与应用完全
 * 一致（同一套配色）、无编码/DPI/黑框/系统边框残留问题。
 *
 * 窗口形态：Windows 风格自绘窗口 —— 顶部标题栏（主题配色、可拖拽、左上角
 * 标题 "InfluxDB View"）+ 底部进度轨道；无最小化/最大化/关闭按钮（纯展示，
 * 安装完成/超时后自动收尾退出）。无窗口控制，因此不再需要业务 preload。
 *
 * 生命周期（主进程轮询，渲染器只负责展示）：
 *   parentPid 存活            → 主应用还在（进度停在 0）
 *   parentPid 消失            → 静默安装中（渐近填充）
 *   新版主窗口 ready-to-show  → 置 100%，900ms 后收尾退出
 *   （收尾依据是新版写下的 update-window-ready.json 标记，非"进程存在"，
 *    确保 100% 对齐"窗口完全显示"，中间无空窗期）
 *   180s 兜底超时
 */
import { app, BrowserWindow } from 'electron';
import * as path from 'path';

/** 进度窗口应用副本的 %TEMP% 目录名前缀。实际目录名带唯一后缀
 *  （`<PROGRESS_DIR_NAME>-<ts>`，见 updater.ts 的 progressAppDir），避免复用
 *  可能被进程锁定的旧副本目录。updater.ts（复制+spawn）与 main.ts（新版启动后
 *  按前缀清理）共用，放本模块避免两处硬编码漂移。 */
export const PROGRESS_DIR_NAME = 'influxdb-view-update-progress';

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return null;
}

/** 进程是否存活（pid 探测） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 新版主窗口是否已真正显示（读它写下的 ready 标记并校验）。
 *  这是进度窗收尾的精确条件：进程存在 ≠ 窗口可见，ready-to-show 才算数。
 *  排除旧版残留标记用的是时间下界而非 pid 对比：旧版的标记必然写于安装
 *  开始之前（markerFloor），且避免 Windows pid 复用导致的误判。 */
function newAppWindowReady(markerFloor: number): boolean {
  try {
    const fs = require('fs') as typeof import('fs');
    const marker = JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), 'update-window-ready.json'), 'utf-8'),
    ) as { pid?: number; at?: number };
    if (!marker.pid || !marker.at) return false;
    if (marker.pid === process.pid) return false;
    // 标记必须写于安装开始之后（新版写的），排除旧版启动时的残留
    if (marker.at < markerFloor) return false;
    // 标记必须是近期的（双保险）
    if (Date.now() - marker.at > 10 * 60 * 1000) return false;
    // pid 须仍存活
    return pidAlive(marker.pid);
  } catch {
    return false;
  }
}

export function runProgressWindow(): void {
  const parentPid = Number(argValue('parent-pid') || 0);
  const theme = argValue('theme') === 'light' ? 'light' : 'dark';

  // 心跳日志：主进程把本进程的 stdout/stderr 重定向到同一文件
  // （%TEMP%\iv-update-progress.log），这里补一条"确实跑起来了"的记录，
  // 排查"进度窗口未出现"类问题时区分「没 spawn」和「spawn 后早夭」
  try {
    require('fs').appendFileSync(
      require('path').join(app.getPath('temp'), 'iv-update-progress.log'),
      `[${new Date().toISOString()}] progress window running, pid=${process.pid}, parentPid=${parentPid}\n`,
    );
  } catch {
    /* 日志失败不影响本体 */
  }

  const W = 400;
  const H = 92;

  const win = new BrowserWindow({
    width: W,
    height: H,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    // 任务栏留条目：最小化后才有处可点还原（skipTaskbar 的窗口最小化=消失）
    skipTaskbar: false,
    alwaysOnTop: true,
    // 无窗口控制按钮（纯展示，安装完成/超时后自动收尾）；focusable:false 在
    // 部分 Windows 版本会吞鼠标事件，这里保留 true 更稳
    focusable: true,
    hasShadow: false,
    show: false,
    center: true,
    title: 'InfluxDB View',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 内联 HTML（无外部文件依赖）：Windows 风格自绘窗口 —— 顶部标题栏（主题配色、
  // 可拖拽、左上角标题）+ 底部进度轨道。无最小化/最大化/关闭按钮（纯展示，
  // 安装完成或超时后自动收尾退出）。填充宽度由主进程经 executeJavaScript 驱动
  // （渲染器零进度逻辑），CSS transition 负责两次驱动之间的平滑插值。
  // 颜色对齐主应用 Mantine 主题（亮/暗），与 .titlebar/.frame 的 --iv-* 语义一致。
  const c =
    theme === 'light'
      ? {
          titlebar: '#ffffff', // 标题栏背景（--iv-bg-panel）
          titleText: '#868e96', // 标题文字（dimmed）
          frame: '#ced4da', // 窗口边框（gray-4 / --iv-border）
          body: '#f8f9fa', // 内容区背景（gray-0 / --iv-bg-app）
          track: '#e9ecef', // 进度轨道（gray-2）
          fill: '#495057', // 进度填充（gray-7）
        }
      : {
          titlebar: '#1a1b1e', // 标题栏背景（dark-7 / --iv-bg-panel）
          titleText: '#909296', // 标题文字（dimmed）
          frame: '#373a40', // 窗口边框（dark-5 / --iv-border）
          body: '#25262b', // 内容区背景（dark-6 / --iv-bg-elevated）
          track: '#373a40', // 进度轨道（dark-5）
          fill: '#c9cdd4', // 进度填充（浅色）
        };
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>InfluxDB View</title><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;height:100%;
    font-family:'Segoe UI',system-ui,sans-serif;user-select:none;cursor:default}
  .frame{position:absolute;left:4px;top:4px;right:4px;bottom:4px;display:flex;flex-direction:column;
    border:1px solid ${c.frame};background:${c.body}}
  .titlebar{height:32px;flex-shrink:0;display:flex;align-items:center;padding:0 12px;
    background:${c.titlebar};border-bottom:1px solid ${c.frame};
    font-size:12px;font-weight:500;color:${c.titleText};-webkit-app-region:drag}
  .body{flex:1;display:flex;align-items:center;padding:0 14px}
  .track{position:relative;flex:1;height:18px;background:${c.track};overflow:hidden}
  .fill{position:absolute;left:0;top:0;bottom:0;width:0;background:${c.fill};
    transition:width 1s linear}
  </style></head><body>
  <div class="frame">
    <div class="titlebar"><span id="title">正在准备更新…</span></div>
    <div class="body"><div class="track"><div class="fill" id="fill"></div></div></div>
  </div>
  <script>
    function setProgress(p) {
      document.getElementById('fill').style.width = (p * 100) + '%';
    }
    function setTitle(t) {
      document.getElementById('title').textContent = t;
    }
  </script>
  </body></html>`;
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', () => {
    win.showInactive();
    // 无 parent-pid（手动测试）直接进入安装态，标题对应用户当前的阶段
    setTitle(sawParentExit ? '正在安装更新…' : '正在准备更新…');
  });

  /** 驱动渲染器进度（0..1） */
  const setBar = (p: number) => {
    void win.webContents
      .executeJavaScript(`setProgress(${p.toFixed(4)})`, true)
      .catch(() => {});
  };

  /** 驱动标题栏状态文本（告诉用户当前正在干嘛） */
  const setTitle = (text: string) => {
    void win.webContents
      .executeJavaScript(`setTitle(${JSON.stringify(text)})`, true)
      .catch(() => {});
  };

  // ---- 生命周期轮询 + 单向进度 ----
  // NSIS 静默安装不报告进度；采用业界通用的渐近填充：
  //   p = 0.95 * (1 - e^(-t/τ))，单调递增、无限逼近 95% 但永不达到，
  //   100% 由真实事件触发（探测到新版主进程启动），绝不回退/循环。
  let sawParentExit = !parentPid; // 无 parent-pid（手动测试）直接进入第二阶段
  let installStart = 0; // 主应用退出（=安装开始）的时刻
  const TAU = 3; // 时间常数（秒）：3 秒到 ~63%，6 秒 ~86%，足够"只走一遍"的观感
  const started = Date.now();
  const timer = setInterval(() => {
    const elapsed = (Date.now() - started) / 1000;
    if (elapsed > 180) {
      clearInterval(timer);
      win.destroy();
      app.quit();
      return;
    }
    if (!sawParentExit) {
      // 主应用还在：进度停在 0（安装尚未开始）
      if (!pidAlive(parentPid)) {
        sawParentExit = true;
        installStart = Date.now();
        setTitle('正在安装更新…');
      }
      return;
    }
    // 安装中：渐近填充到 95%
    const t = (Date.now() - (installStart || started)) / 1000;
    setBar(0.95 * (1 - Math.exp(-t / TAU)));
    // 新版主窗口已真正显示（ready-to-show 标记）：真实完成 → 100% → 收尾
    if (newAppWindowReady(installStart || started)) {
      clearInterval(timer);
      setTitle('安装完成');
      setBar(1);
      setTimeout(() => {
        win.destroy();
        app.quit();
      }, 900);
    }
  }, 1000);

  win.on('closed', () => {
    // 用户点 X 关闭也会走到这里：定时器之外必须让进程退出，
    // 否则窗口没了、进度进程却作为隐形僵尸一直挂着（180s 兜底也被清了）
    clearInterval(timer);
    app.quit();
  });
}
