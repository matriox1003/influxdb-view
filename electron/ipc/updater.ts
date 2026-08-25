/**
 * 应用更新：基于 electron-updater + GitHub Releases。
 * - CI（build-windows.yml）发布 v* 标签时会产出 latest.yml，正是更新元数据
 * - 渲染层通过 preload 暴露的 appUpdater API 交互（检查/下载/安装）
 * - 下载进度与完成事件经 IPC 推送到渲染层
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Electron 会给 fs（及 fs.promises）打 asar 补丁：对应用目录里的 app.asar
// 归档本身调用 copyFile 会抛 "ENOENT: not found in <app.asar>"（实测复现）。
// original-fs 是未打补丁的原生 fs（仅主进程可用），用于把 app.asar 当普通
// 文件整体复制到 %TEMP%，进度窗口副本才能完整就绪。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const originalFs = require('original-fs') as typeof import('fs');
import { autoUpdater } from 'electron-updater';
import type { UpdateCheckResult, UpdateProgress } from '../types';
import { PROGRESS_DIR_NAME } from '../progress-window';

/** GitHub 仓库（与 CI 发布 Release 的仓库一致） */
const REPO = { owner: 'matriox1003', repo: 'influxdb-view' };

/** 便携版（electron-builder portable 目标运行时设置此环境变量）。
 *  便携版没有安装器/注册表，应用内更新会静默装出一个 NSIS 安装版，
 *  而便携 exe 本体仍在旧版本——所以便携版禁用应用内更新入口。 */
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;

/** 本次更新使用的副本目录名（唯一后缀）。每次复制开始时重置为 null，
 *  progressAppDir() 首次调用时生成 `influxdb-view-update-progress-<ts>`，
 *  保证复制与 spawn 用同一目录，且不复用旧目录。
 *  教训（v1.1.20 实测）：固定目录名会导致上次更新残留的副本因进程占用
 *  app.asar 而无法删除，复制卡死在 rmRecursive —— 重试无效，必须避开旧目录。 */
let progressCopyDir: string | null = null;

/** 进度窗口应用副本目录（%TEMP%\<唯一目录名>，null = 非打包环境）。
 *  必须复制整棵应用目录而不只是 exe：Electron 运行时按「exe 所在目录」
 *  加载 icudtl.dat / *.pak / resources\ / locales\ 等支持文件。 */
function progressAppDir(): string | null {
  if (!app.isPackaged) return null;
  if (!progressCopyDir) progressCopyDir = `${PROGRESS_DIR_NAME}-${Date.now()}`;
  return path.join(app.getPath('temp'), progressCopyDir);
}

/** 进度窗口 exe 路径。文件名刻意与应用主 exe 不同：NSIS 安装器/卸载器
 *  用 tasklist/taskkill 的 IMAGENAME eq（按映像名精确匹配）清理主应用
 *  进程，名字相同会被连带杀掉。 */
function progressExePath(): string | null {
  const dir = progressAppDir();
  if (!dir) return null;
  const exePath = process.execPath;
  const ext = path.extname(exePath);
  return path.join(dir, `${path.basename(exePath, ext)}-update-progress${ext}`);
}

/** 递归复制目录树（用 original-fs 规避 Electron 的 asar 补丁：必须能把
 *  app.asar 归档当作一个普通文件复制过去）。 */
async function copyTree(src: string, dst: string): Promise<void> {
  await originalFs.promises.mkdir(dst, { recursive: true });
  for (const e of await originalFs.promises.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else if (e.isFile()) await originalFs.promises.copyFile(s, d);
  }
}

let progressCopyPromise: Promise<boolean> | null = null;

/** 进度日志写入 %TEMP%\iv-update-progress.log（与 spawn 重定向同一文件）。
 *  copyTree 失败时要记录真实错误，避免 catch 吞掉后无从排查。 */
function progressLog(line: string): void {
  try {
    fs.appendFileSync(
      path.join(app.getPath('temp'), 'iv-update-progress.log'),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch {
    /* 日志失败忽略 */
  }
}

/** sleep 延迟（毫秒） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 递归删除，带退避重试：Windows 上删除含大文件（app.asar）的目录时，
 *  文件会被杀毒扫描/瞬时锁临时占用，fs.promises.rm recursive 会间歇抛
 *  ENOTEMPTY/EPERM/EBUSY（实测 v1.1.20：rmdir 报 "directory not empty"）。
 *  逐次退避重试（最多 6 次，~6s）扛住这类瞬时失败；最终失败仍抛出让上层捕获。 */
async function rmRecursive(target: string): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 6) {
        progressLog(`rmRecursive finally failed: ${target} (${err instanceof Error ? err.message : String(err)})`);
        throw err;
      }
      await delay(400 * attempt); // 退避 0.4s,0.8s,1.2s,1.6s,2.0s
    }
  }
}

/** 清理 %TEMP% 下所有历史副本目录（唯一后缀 + 固定名）。这只是清垃圾、不关键，
 *  因此**单次尝试、失败即跳过**——被占用的目录立刻放弃，绝不重试阻塞本次复制
 *  （否则点击重启后主应用会一直 await，窗口迟迟不关）。残留的目录交由新版启动
 *  时按前缀清理。 */
async function cleanupStaleProgressDirs(): Promise<void> {
  const temp = app.getPath('temp');
  let dirs: string[] = [];
  try {
    dirs = (await fs.promises.readdir(temp, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith(PROGRESS_DIR_NAME))
      .map((e) => path.join(temp, e.name));
  } catch {
    return;
  }
  for (const d of dirs) {
    try {
      await fs.promises.rm(d, { recursive: true, force: true });
    } catch {
      /* 被占用，跳过；留待后续清理 */
    }
  }
}

/** 确保 %TEMP% 下的进度窗口应用副本就绪（单飞：并发调用共享同一次执行）。
 *
 * 教训（v1.1.9 的真实事故）：下载完成即开始异步复制（约 384MB 需数秒），
 * 与用户点击"重启并更新"触发的同步兜底复制并发执行——两路 copyFile 同时
 * 写同一目标、两路 rename 互相竞争，要么把子进程正在加载的文件截断损坏、
 * 要么让就绪标志停在 false 直接不 spawn，表现为"进度条不显示"。
 *
 * 现在的结构性防护：
 * - 单飞 Promise：任何时刻最多一路复制在跑，点击路径 await 它而非另起一路；
 * - 暂存目录 + 原子换名：先完整复制到 <dir>.staging，再把主 exe 在暂存内
 *   改名、最后一次性 rename 成正式目录——正式目录要么不存在、要么完整，
 *   不存在"半截副本"被 spawn 的可能；
 * - 失败清掉单飞引用，允许下一次调用重试。
 *
 * 追加防护（v1.1.14 实测事故）：运行时 resources/app.asar 会被杀毒软件或
 * 瞬时锁偶发短暂占用，单次 copyFile 抛异常就导致整棵复制失败、返回 false，
 * 于是不 spawn 进度窗口、安装静默进行——表现为"进度条不显示"。复制本身极快
 * （~0.3s），这里重试 3 次、失败写下真实错误，扛住瞬时失败并留下排查现场。
 */
function ensureProgressCopy(): Promise<boolean> {
  if (progressCopyPromise) return progressCopyPromise;
  // 新一次复制：重置为唯一目录名，绝不复用（可能被锁定的）旧副本目录
  progressCopyDir = null;
  const run = (async (): Promise<boolean> => {
    // 复制前清扫历史副本目录（占用中的跳过），避免积累垃圾
    await cleanupStaleProgressDirs();
    const dir = progressAppDir();
    const exe = progressExePath();
    if (!dir || !exe) return false;
    const staging = `${dir}.staging`;
    // 单次完整执行：复制 -> 暂存内改主 exe 名 -> 清正式目录 -> 原子换名。
    // 失败会留下半截 staging，下一次执行开头清理。
    const attemptOnce = async (): Promise<void> => {
      await rmRecursive(staging);
      await copyTree(path.dirname(process.execPath), staging);
      await fs.promises.rename(
        path.join(staging, path.basename(process.execPath)),
        // 目标就在暂存目录内（改名后随目录一起换名过去）
        path.join(staging, path.basename(exe)),
      );
      // 清掉上次更新可能残留的旧副本，再原子换名到正式路径
      await rmRecursive(dir);
      await fs.promises.rename(staging, dir);
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await attemptOnce();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        progressLog(`progress copy attempt ${attempt}/3 failed: ${msg}`);
        if (attempt < 3) {
          await delay(600);
        } else {
          // 最终失败：清掉半截 staging，避免残留占用
          try {
            await rmRecursive(staging);
          } catch {
            /* 清理失败忽略 */
          }
        }
      }
    }
    return false;
  })();
  progressCopyPromise = run;
  // 失败不缓存：下次（比如点击时）重试
  void run.then((ok) => {
    if (!ok && progressCopyPromise === run) progressCopyPromise = null;
  });
  return run;
}

/**
 * 迷你安装进度窗口：以独立 Electron 进程运行（--update-progress 参数），
 * 启动自 %TEMP% 下的完整应用目录副本。
 *
 * 为什么必须"整棵目录复制到 %TEMP%"而不是复制 exe 到安装目录：
 * 1) NSIS 静默安装器/旧卸载器用 taskkill /im "<应用exe名>" 按映像名清理
 *    主应用进程（allowOnlyOneInstallerInstance.nsh 的 _CHECK_APP_RUNNING），
 *    进度窗口 exe 与主应用同名会被连带杀掉（进度条只显示 ~2 秒的根因）；
 * 2) 运行中的 Electron 会以不可重命名的方式锁住 icudtl.dat、
 *    v8_context_snapshot.bin、locales\（实测），而旧卸载器更新路径的
 *    un.atomicRMDir 必须把安装目录内每个文件 rename 走——任一失败即
 *    Abort（退出码 2），安装器弹
 *    "Failed to uninstall old application files .: 2" 且更新中断。
 *    即使 exe 换了名字，从安装目录启动就仍会锁这些支持文件。
 *    从 %TEMP% 副本启动后，进程与安装目录零句柄/零 CWD 关联，
 *    卸载器可随意清理安装目录。
 * 代价：%TEMP% 多占约 260MB（新版启动时由 main.ts 清理；应用被杀则由
 * 系统存储感知回收）。
 *
 * 方案演进（全部实测）：
 * - Electron 子窗口：随主进程退出而死 ✗
 * - PowerShell WinForms / Win32 API / mshta：各有 spawn 静默失败/边框问题 ✗
 * - spawn(安装目录同名 exe)：被安装器按映像名强杀 ✗
 * - spawn(安装目录改名 exe 副本)：不再被杀，但锁死 icudtl.dat 等 →
 *   旧卸载器 atomicRMDir Abort，弹"Failed to uninstall old application files" ✗
 * - 本方案（最终）：%TEMP% 完整目录副本，与安装目录彻底解耦 ✓
 */
function spawnInstallProgressWindow(): void {
  // 前置条件：副本已就绪（调用方 ensureProgressCopy 通过后才调用）
  const dir = progressAppDir();
  const exe = progressExePath();
  if (!dir || !exe) return;

  // 读取用户当前主题（与 userData/theme.json 同源），进度窗口配色跟随
  let theme = 'dark';
  try {
    const themeJson = JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), 'theme.json'), 'utf-8'),
    ) as { value?: string };
    // system 模式无法在独立进程里解析系统主题，默认用暗色（应用主基调）
    if (themeJson.value === 'light') theme = 'light';
  } catch {
    /* 读不到按暗色 */
  }

  // 子进程 stdout/stderr 追加重定向到日志文件：出问题时（进度窗口未出现
  // 之类）有现场可查，而不是 stdio:'ignore' 一抹黑
  let logFd: number | null = null;
  const logPath = path.join(app.getPath('temp'), 'iv-update-progress.log');
  try {
    logFd = fs.openSync(logPath, 'a');
    fs.writeSync(logFd, `[${new Date().toISOString()}] spawning progress child, parent pid=${process.pid}\n`);
  } catch {
    logFd = null;
  }

  try {
    const child = spawn(
      exe,
      ['--update-progress', `--parent-pid=${process.pid}`, `--theme=${theme}`],
      // cwd 显式指向副本目录：进程不得以安装目录为 CWD（目录句柄会阻碍清理）
      {
        detached: true,
        cwd: dir,
        stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      },
    );
    child.unref();
  } catch (err) {
    try {
      if (logFd !== null) {
        fs.writeSync(logFd, `[${new Date().toISOString()}] spawn FAILED: ${err}\n`);
      }
    } catch {
      /* 日志失败忽略 */
    }
  }
}
/**
 * GitHub（Atom feed）返回的 releaseNotes 是渲染后的 HTML（<p>/<br> 等），
 * 转成纯文本给弹窗展示：块级标签转换行、列表项加符号、去标签、解实体。
 * 注意：feed 的 HTML 里"软换行"被输出成「真实换行 + <br>」的组合，若二者
 * 各自转成一个 \n，每行之间会被撑出空行——必须把标签两侧的空白（含源码
 * 换行）与标签一起消费，由标签本身输出唯一的分隔符。
 * 开头的版本号标题行（如 "v1.1.2"）剥离——弹窗已单独展示版本号。
 */
function releaseNotesToText(html: string): string {
  const text = html
    .replace(/\s*<br\s*\/?>\s*/gi, '\n')
    .replace(/\s*<\/li>\s*/gi, '\n')
    .replace(/\s*<\/(p|div|h[1-6]|ul|ol)>\s*/gi, '\n\n')
    .replace(/<li[^>]*>\s*/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 剥离开头独立的版本号行（v1.2.3 / 1.2.3）
  return text.replace(/^v?\d+\.\d+\.\d+\s*\n+/, '').trim();
}

/** 语义化版本比较：remote 是否严格大于 current。
 *  只比较 major.minor.patch 数字段（预发布/构建元数据忽略——
 *  allowPrerelease=false 时 electron-updater 已过滤预发布版）。
 *  之前的字符串不等比较会把「GitHub 上版本比本地旧」误报为有更新
 *  （实为降级，比如本地装了 1.1.7 而线上最新是 1.1.6）。 */
function isNewerVersion(remote: string, current: string): boolean {
  const parts = (v: string) =>
    v
      .split(/[+-]/)[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const [r, c] = [parts(remote), parts(current)];
  for (let i = 0; i < 3; i++) {
    const a = r[i] ?? 0;
    const b = c[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** 检查更新前必须配置 feed 源 */
function configureFeed(): void {
  // 显式指定 GitHub provider：即使应用未签名/未配置 publish 字段也能工作
  autoUpdater.setFeedURL({
    provider: 'github',
    ...REPO,
  });
  autoUpdater.autoDownload = false; // 由用户点击触发下载
  autoUpdater.autoInstallOnAppQuit = true; // 下载完成后若用户直接退出，退出时自动安装
  autoUpdater.allowPrerelease = false;
}

export function registerUpdaterIpc(): void {
  // ---- 事件转发：electron-updater -> 渲染层 ----
  autoUpdater.on('download-progress', (progress) => {
    const payload: UpdateProgress = {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    };
    push('updater:progress', payload);
  });

  autoUpdater.on('update-downloaded', (info) => {
    push('updater:downloaded', { version: info.version });
    // 提前开始复制进度窗口的 %TEMP% 应用副本（见 ensureProgressCopy 注释），
    // 让点"重启并更新"时基本零等待
    void ensureProgressCopy();
  });

  // ---- IPC 处理器 ----
  ipcMain.handle('updater:check', async (): Promise<UpdateCheckResult> => {
    // 便携版：不发起检查，返回结构化的"不支持"结果（渲染层据此展示引导文案）
    if (IS_PORTABLE) {
      return {
        available: false,
        version: null,
        currentVersion: autoUpdater.currentVersion.version,
        releaseNotes: null,
        releaseUrl: `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest`,
        portable: true,
      };
    }
    configureFeed();
    // 注意：autoUpdater.currentVersion 是 semver 的 SemVer 对象，不是字符串。
    // 直接传给渲染层会变成不可序列化的对象，渲染时抛
    // "Objects are not valid as a React child"。必须取 .version 字符串。
    const currentVersion: string = autoUpdater.currentVersion.version;
    try {
      const result = await autoUpdater.checkForUpdates();
      const updateInfo = result?.updateInfo;
      // 语义化比较：只有线上版本严格大于本地才算有更新
      const hasUpdate = !!updateInfo && isNewerVersion(updateInfo.version, currentVersion);
      // releaseNotes 格式不定：字符串 / { note: string } / ReleaseNoteInfo[]（多语言），
      // 统一解析为可展示的 Markdown 字符串
      const rawNotes: unknown = updateInfo?.releaseNotes;
      let releaseNotes: string | null = null;
      if (typeof rawNotes === 'string') {
        releaseNotes = releaseNotesToText(rawNotes);
      } else if (Array.isArray(rawNotes)) {
        releaseNotes =
          rawNotes
            .map((n) => (typeof (n as { note?: unknown })?.note === 'string' ? (n as { note: string }).note : ''))
            .filter(Boolean)
            .join('\n\n') || null;
      } else if (rawNotes && typeof rawNotes === 'object' && typeof (rawNotes as { note?: unknown }).note === 'string') {
        releaseNotes = releaseNotesToText((rawNotes as { note: string }).note);
      }
      return {
        available: hasUpdate,
        version: hasUpdate ? updateInfo.version : null,
        currentVersion,
        releaseNotes,
        releaseUrl: updateInfo ? `https://github.com/${REPO.owner}/${REPO.repo}/releases/tag/v${updateInfo.version}` : null,
      };
    } catch (err) {
      // 网络不可达 / GitHub 访问受限等，返回结构化错误而非抛异常
      return {
        available: false,
        version: null,
        currentVersion,
        releaseNotes: null,
        releaseUrl: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle('updater:download', async (): Promise<{ ok: boolean; error?: string }> => {
    if (IS_PORTABLE) return { ok: false, error: '便携版不支持应用内更新' };
    try {
      configureFeed();
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 注意：preload 用 ipcRenderer.send，这里必须用 ipcMain.on（handle 收不到 send）
  ipcMain.on('updater:install', () => {
    if (IS_PORTABLE) return; // 双保险：便携版不应走到这里（check 已拦截）
    void (async () => {
      // 串行等待副本就绪（单飞；正常情况下载完成时就已复制好，这里瞬间通过。
      // 罕见的未就绪场景会阻塞几秒——可接受，且杜绝并发复制损坏副本）。
      const ready = await ensureProgressCopy();
      if (ready) {
        // 等 spawn 真正完成（子进程已创建、不会随主进程退出被清理）再触发
        // 退出+安装。之前同步连发，主进程在子进程完成 Windows 进程创建前
        // 就退出了，导致进度窗口从未出现。
        spawnInstallProgressWindow();
      }
      // 副本失败只是没有进度条，安装本体必须继续
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    })();
  });

  // 渲染层注册监听：ipcRenderer.on 在主进程侧无需显式注册，
  // 进度事件直接经 webContents.send 推送（见 push）

  // 当前应用版本号（package.json 的 version；设置菜单显示用）
  ipcMain.handle('updater:getVersion', () => app.getVersion());
}

/** 主进程 -> 渲染层推送（所有窗口） */
function push(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
