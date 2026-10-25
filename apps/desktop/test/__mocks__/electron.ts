export const ipcMain = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
};

export const app = {
  getPath: (_name: string) => '/tmp',
  getVersion: () => '0.4.2',
  whenReady: () => Promise.resolve(),
  quit: () => {},
};

export const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: undefined }),
};

export const shell = {
  openPath: () => Promise.resolve(''),
  openExternal: () => Promise.resolve(),
};

export class BrowserWindow {
  webContents = {
    send: () => {},
  };
  loadURL = () => Promise.resolve();
  loadFile = () => Promise.resolve();
}

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};

export default {
  ipcMain,
  app,
  dialog,
  shell,
  BrowserWindow,
  safeStorage,
};
