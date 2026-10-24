import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopApi } from './types';

const api: DesktopApi = {
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  inspectPolicyGroups: (input) => ipcRenderer.invoke('desktop:inspect-policy-groups', input),
  saveSources: (input) => ipcRenderer.invoke('desktop:save-sources', input),
  saveSettings: (input) => ipcRenderer.invoke('desktop:save-settings', input),
  runAction: (action) => ipcRenderer.invoke('desktop:run-action', action),
  repairCheck: (check) => ipcRenderer.invoke('desktop:repair-check', check),
  installSingBox: (method) => ipcRenderer.invoke('desktop:install-sing-box', method),
  checkSingBoxUpdate: () => ipcRenderer.invoke('desktop:check-sing-box-update'),
  rollbackSingBox: () => ipcRenderer.invoke('desktop:rollback-sing-box'),
  installMihomo: (method) => ipcRenderer.invoke('desktop:install-mihomo', method),
  checkMihomoUpdate: () => ipcRenderer.invoke('desktop:check-mihomo-update'),
  rollbackMihomo: () => ipcRenderer.invoke('desktop:rollback-mihomo'),
  controlMihomo: (action) => ipcRenderer.invoke('desktop:control-mihomo', action),
  switchEngine: (targetMode) => ipcRenderer.invoke('desktop:switch-engine', targetMode),
  saveSchedule: (input) => ipcRenderer.invoke('desktop:save-schedule', input),
  disableSchedule: () => ipcRenderer.invoke('desktop:disable-schedule'),
  clearHistory: () => ipcRenderer.invoke('desktop:clear-history'),
  cleanOldBackups: () => ipcRenderer.invoke('desktop:clean-old-backups'),
  chooseFile: (kind) => ipcRenderer.invoke('desktop:choose-file', kind),
  confirm: (input) => ipcRenderer.invoke('desktop:confirm', input),
  revealPath: (path) => ipcRenderer.invoke('desktop:reveal-path', path),
  onInstallProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress);
    ipcRenderer.on('desktop:install-progress', handler);
    return () => ipcRenderer.removeListener('desktop:install-progress', handler);
  },
};

contextBridge.exposeInMainWorld('surgeBridge', api);
