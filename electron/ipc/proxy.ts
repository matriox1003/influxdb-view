/**
 * 网络代理相关 IPC（渲染层「设置 → 网络代理」使用）。
 * 具体逻辑见 electron/proxy.ts。
 */
import { ipcMain } from 'electron';
import {
  getProxySettings,
  getSystemProxyInfo,
  saveProxySettings,
  testProxy,
} from '../proxy';
import type { ProxySettingsInput, ProxySettingsView, ProxyTestResult, SystemProxyInfo } from '../types';

export function registerProxyIpc(): void {
  ipcMain.handle('proxy:get', (): ProxySettingsView => getProxySettings());

  ipcMain.handle(
    'proxy:save',
    async (_e, cfg: ProxySettingsInput): Promise<ProxySettingsView> => saveProxySettings(cfg),
  );

  ipcMain.handle('proxy:systemInfo', async (): Promise<SystemProxyInfo> => getSystemProxyInfo());

  ipcMain.handle(
    'proxy:test',
    async (_e, cfg: ProxySettingsInput): Promise<ProxyTestResult> => testProxy(cfg),
  );
}
