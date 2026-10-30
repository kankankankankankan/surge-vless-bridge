import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { RuntimeMode } from '../types/cli-config';
import { DesktopService } from './service';
import type {
  DesktopAction,
  DesktopConfigView,
  MihomoInstallMethod,
  MihomoServiceAction,
  RepairableCheck,
  ScheduleSettings,
  SingBoxInstallMethod,
} from './types';

app.name = 'Surge VLESS Bridge';

let mainWindow: BrowserWindow | undefined;
let service: DesktopService;

const applicationVersion = () => {
  try {
    const metadata = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version?: string };
    return metadata.version ?? app.getVersion();
  } catch {
    return app.getVersion();
  }
};

const scheduledEntryPath = () =>
  app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'desktop', 'scheduled-run.js')
    : join(__dirname, 'scheduled-run.js');

const rendererEntryPath = () =>
  app.isPackaged
    ? join(process.resourcesPath, 'renderer', 'index.html')
    : join(__dirname, 'renderer', 'index.html');

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const loadRenderer = async (window: BrowserWindow) => {
  const entryPath = rendererEntryPath();
  try {
    await window.loadFile(entryPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load desktop renderer at ${entryPath}: ${reason}`);
    const page = `<!doctype html><meta charset="utf-8"><title>Surge VLESS Bridge</title><style>body{margin:0;padding:48px;font:15px -apple-system,BlinkMacSystemFont,sans-serif;color:#202124;background:#f5f5f7}main{max-width:680px;margin:10vh auto;padding:28px;background:#fff;border:1px solid #d8d8dc;border-radius:8px}h1{font-size:22px;margin:0 0 12px}p{line-height:1.6;color:#555}code{display:block;padding:12px;background:#f0f0f2;overflow-wrap:anywhere}</style><main><h1>界面资源加载失败</h1><p>应用安装包缺少必要文件，请重新安装完整版本。</p><code>${escapeHtml(entryPath)}</code></main>`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  }
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#f5f5f7',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void loadRenderer(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
};

const registerIpc = () => {
  ipcMain.handle('desktop:get-version', applicationVersion);
  ipcMain.handle('desktop:get-state', () => service.getState());
  ipcMain.handle(
    'desktop:inspect-policy-groups',
    (_event, input: { surgeConfigPath: string; policyGroupName: string }) => service.inspectPolicyGroups(input),
  );
  ipcMain.handle(
    'desktop:save-sources',
    (_event, input: { subscriptionUrls: string[]; subscriptionNames?: string[]; vlessNodes: string[] }) =>
      service.saveSources(input),
  );
  ipcMain.handle('desktop:save-settings', (_event, input: DesktopConfigView) => service.saveSettings(input));
  ipcMain.handle('desktop:run-action', (_event, action: DesktopAction) => service.runAction(action));
  ipcMain.handle('desktop:repair-check', (_event, check: RepairableCheck) => service.repairCheck(check));
  ipcMain.handle('desktop:install-sing-box', (_event, method: SingBoxInstallMethod) => service.installSingBox(method));
  ipcMain.handle('desktop:check-sing-box-update', () => service.checkSingBoxUpdate());
  ipcMain.handle('desktop:rollback-sing-box', () => service.rollbackSingBox());
  ipcMain.handle('desktop:install-mihomo', (_event, method: MihomoInstallMethod) => service.installMihomo(method));
  ipcMain.handle('desktop:diagnose-node', (_event, input: { port: number; name: string }) => service.diagnoseNode(input));
  ipcMain.handle('desktop:check-mihomo-update', () => service.checkMihomoUpdate());
  ipcMain.handle('desktop:rollback-mihomo', () => service.rollbackMihomo());
  ipcMain.handle('desktop:control-mihomo', (_event, action: MihomoServiceAction) => service.controlMihomo(action));
  ipcMain.handle('desktop:switch-engine', (_event, targetMode: RuntimeMode) => service.switchEngine(targetMode));
  ipcMain.handle('desktop:save-schedule', (_event, input: ScheduleSettings) => service.saveSchedule(input));
  ipcMain.handle('desktop:disable-schedule', () => service.disableSchedule());
  ipcMain.handle('desktop:clear-history', () => service.clearHistory());
  ipcMain.handle('desktop:clean-old-backups', () => service.cleanOldBackups());
  ipcMain.handle('desktop:choose-file', async (_event, kind: 'surge-profile' | 'sing-box' | 'mihomo') => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title:
        kind === 'surge-profile'
          ? '选择 Surge 配置文件'
          : kind === 'mihomo'
            ? '选择 Mihomo 可执行文件'
            : '选择 sing-box 可执行文件',
      defaultPath:
        kind === 'surge-profile'
          ? join(homedir(), 'Library', 'Application Support', 'Surge', 'Profiles')
          : '/opt/homebrew/bin',
      properties: ['openFile'],
      filters: kind === 'surge-profile' ? [{ name: 'Surge Profile', extensions: ['conf'] }] : undefined,
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle(
    'desktop:confirm',
    async (_event, input: { title: string; message: string; detail?: string }) => {
      const result = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: input.title,
        message: input.message,
        detail: input.detail,
        buttons: ['继续', '取消'],
        defaultId: 1,
        cancelId: 1,
      });
      return result.response === 0;
    },
  );
  ipcMain.handle('desktop:reveal-path', async (_event, path: string) => {
    shell.showItemInFolder(path);
  });
};

const installMenu = () => {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

void app.whenReady().then(() => {
  service = new DesktopService({
    executablePath: process.execPath,
    scheduledEntryPath: scheduledEntryPath(),
    onInstallProgress: (progress) => mainWindow?.webContents.send('desktop:install-progress', progress),
  });
  registerIpc();
  installMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
