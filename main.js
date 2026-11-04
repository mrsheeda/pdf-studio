'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');

let win = null;
let dirty = false;
let forceClose = false;

function pdfFromArgv(argv) {
  return argv.slice(1).find((a) => /\.pdf$/i.test(a) && fs.existsSync(a)) || null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on('second-instance', (_e, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    const f = pdfFromArgv(argv);
    if (f) win.webContents.send('open-path', f);
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#eef0f4',
    autoHideMenuBar: true,
    title: 'PDF Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    const f = pdfFromArgv(process.argv);
    if (f) win.webContents.send('open-path', f);
  });

  win.on('close', (e) => {
    if (!dirty || forceClose) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Save changes', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: 'You have unsaved changes. Save before closing?',
    });
    if (choice === 2) {
      e.preventDefault();
    } else if (choice === 0) {
      e.preventDefault();
      win.webContents.send('command', 'save-and-close');
    }
  });
  win.on('closed', () => (win = null));
}

function buildMenu() {
  const send = (c) => () => win && win.webContents.send('command', c);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------
function readPdfFile(p) {
  const data = fs.readFileSync(p);
  return { path: p, name: path.basename(p), data: new Uint8Array(data) };
}

ipcMain.handle('file:open-dialog', async (_e, { multi } = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open PDF',
    properties: ['openFile', ...(multi ? ['multiSelections'] : [])],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths.map(readPdfFile);
});

ipcMain.handle('file:read', async (_e, p) => readPdfFile(p));

ipcMain.handle('file:save', async (_e, { data, defaultName, path: p }) => {
  let target = p;
  if (!target) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save PDF',
      defaultPath: defaultName || 'document.pdf',
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  fs.writeFileSync(target, Buffer.from(data));
  return { path: target, name: path.basename(target) };
});

ipcMain.handle('file:save-as', async (_e, { data, defaultName }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save PDF as',
    defaultPath: defaultName || 'document.pdf',
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return { path: r.filePath, name: path.basename(r.filePath) };
});

// ----- Windows system fonts (for Unicode text / nicer fonts) -----
const FONT_FILES = {
  Arial: ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  'Times New Roman': ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  'Courier New': ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
  Calibri: ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
  'Segoe UI': ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
  Tahoma: ['tahoma.ttf', 'tahomabd.ttf'],
  Verdana: ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'],
  Georgia: ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'],
};
const fontDir = () => path.join(process.env.windir || process.env.SystemRoot || 'C:\\Windows', 'Fonts');

ipcMain.handle('fonts:list', async () => {
  const dir = fontDir();
  return Object.keys(FONT_FILES).filter((f) => fs.existsSync(path.join(dir, FONT_FILES[f][0])));
});

ipcMain.handle('fonts:read', async (_e, { family, bold, italic }) => {
  const files = FONT_FILES[family];
  if (!files) return null;
  const dir = fontDir();
  const idx = (bold ? 1 : 0) + (italic ? 2 : 0);
  for (const f of [files[idx], files[bold ? 1 : 0], files[0]]) {
    if (f && fs.existsSync(path.join(dir, f))) return new Uint8Array(fs.readFileSync(path.join(dir, f)));
  }
  return null;
});

ipcMain.on('app:dirty', (_e, { isDirty, name }) => {
  dirty = !!isDirty;
  if (win) win.setTitle(`${isDirty ? '● ' : ''}${name ? name + ' — ' : ''}PDF Studio`);
});

ipcMain.on('app:close-now', () => {
  forceClose = true;
  if (win) win.close();
});
