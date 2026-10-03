import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runPhp,
  runPhpOverSsh,
  validateProject,
  testSshConnection,
  normalizeSshConfig,
  validateSshConfig,
} from "./executor.js";
import { runJs, getNodeVersion } from "./jsExecutor.js";
import { detectPhpBinary, validatePhpBinary } from "./phpRuntime.js";
import { createPhpRuntimeService } from "./phpRuntimeService.js";
import {
  scanClasses,
  scanRemoteClasses,
  loadCachedScan,
  saveScanToDisk,
  getCachedScan,
  setCachedScan,
  CACHE_TTL_MS,
  remoteCacheKey,
} from "./classScanner.js";
import {
  getTabs,
  setTabs,
  getActiveTabId,
  setActiveTabId,
  getRecentProjects,
  addRecentProject,
  getPhpPath,
  setPhpPath,
  getSshConnections,
  getSshConnection,
  saveSshConnection,
  deleteSshConnection,
} from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const bundledNodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

// Branding. In dev on macOS the app name + dock icon come from Electron's own
// bundle (Electron.app), not from package.json or BrowserWindow.icon. Override
// them at runtime so dev mode matches the packaged build.
const APP_NAME = "PHP Tinker";
const ICON_PATH = path.join(__dirname, "../build/icon.png");

process.title = APP_NAME;
app.name = APP_NAME;
app.setName(APP_NAME);
app.setAboutPanelOptions({ applicationName: APP_NAME });
if (process.platform === "darwin" && app.dock) {
  try {
    app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
  } catch {}
}

let mainWindow = null;

const phpRuntime = createPhpRuntimeService({
  readPath: getPhpPath,
  writePath: setPhpPath,
  detect: detectPhpBinary,
  validate: validatePhpBinary,
});

/* ------------------------------------------------------------------ */
/* Per-project class scan: in-flight de-dup + ensure helper.          */
/* The cache itself lives in classScanner.js (LRU-bounded).           */
/* ------------------------------------------------------------------ */

const activeScans = new Map(); // projectPath -> Promise

async function requirePhpRuntime() {
  const runtime = await phpRuntime.get();
  if (!runtime.ok || !runtime.path || !path.isAbsolute(runtime.path)) {
    throw new Error(runtime.error || "Configure a valid absolute PHP executable path first.");
  }
  return runtime.path;
}

function broadcastScanProgress(projectPath, progress) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("classes:scanProgress", {
      ...progress,
      projectPath,
    });
  }
}

async function ensureScan(projectPath, { force = false } = {}) {
  if (!projectPath) return null;

  if (!force) {
    const inMem = getCachedScan(projectPath);
    if (inMem) return inMem;
  }

  if (activeScans.has(projectPath) && !force) {
    return activeScans.get(projectPath);
  }

  const userData = app.getPath("userData");

  const promise = (async () => {
    if (!force) {
      const cached = await loadCachedScan(userData, projectPath);
      if (cached) {
        setCachedScan(projectPath, cached);
        broadcastScanProgress(projectPath, {
          phase: "done",
          count: cached.count,
          fromCache: true,
        });
        backgroundRescan(projectPath, userData).catch(() => {});
        return cached;
      }
    }

    broadcastScanProgress(projectPath, { phase: "reading", count: 0 });
    const scan = await scanClasses(projectPath, {
      phpPath: await requirePhpRuntime(),
      onProgress: (p) => broadcastScanProgress(projectPath, p),
    });
    setCachedScan(projectPath, scan);
    saveScanToDisk(userData, projectPath, scan).catch(() => {});
    return scan;
  })();

  activeScans.set(projectPath, promise);
  try {
    return await promise;
  } catch (error) {
    broadcastScanProgress(projectPath, { phase: "error", count: 0 });
    throw error;
  } finally {
    activeScans.delete(projectPath);
  }
}

async function backgroundRescan(projectPath, userData) {
  const scan = await scanClasses(projectPath, { phpPath: await requirePhpRuntime() });
  setCachedScan(projectPath, scan);
  saveScanToDisk(userData, projectPath, scan).catch(() => {});
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("classes:scanProgress", {
      projectPath,
      phase: "done",
      count: scan.count,
      fromCache: false,
      silent: true,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Window                                                             */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#1a1a1a",
    title: APP_NAME,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );

  if (isDev && VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
    if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ */
/* Project resolution by path (no longer global state)                */
/* ------------------------------------------------------------------ */

async function resolveProject(projectPath) {
  const base = {
    projectPath: null,
    isLaravel: false,
    laravelVersion: null,
    name: null,
    autoloadPath: null,
    bootstrapPath: null,
    hasPackageJson: false,
    nodeProjectName: null,
    mode: "raw",
  };

  if (!projectPath) return base;

  const v = await validateProject(projectPath);
  if (!v.valid) {
    return { ...base, error: v.error, invalidPath: projectPath };
  }

  // Mode is PHP-execution-mode. Node-only projects fall back to "raw" so
  // PHP runs without any composer autoload — JS mode ignores this field.
  let mode = "raw";
  if (v.isLaravel) mode = "laravel";
  else if (v.autoloadPath) mode = "composer";

  return {
    projectPath,
    isLaravel: v.isLaravel,
    laravelVersion: v.laravelVersion,
    name: v.name,
    autoloadPath: v.autoloadPath,
    bootstrapPath: v.bootstrapPath,
    hasPackageJson: v.hasPackageJson,
    nodeProjectName: v.nodeProjectName,
    mode,
  };
}

/* ------------------------------------------------------------------ */
/* IPC                                                                */
/* ------------------------------------------------------------------ */

// php:run is per-tab. Caller passes tabId + projectPath; output is streamed
// with the tabId attached so the renderer routes it without depending on
// "the currently active tab."
ipcMain.handle("php:run", async (event, code, options = {}) => {
  const {
    tabId = null,
    projectPath = null,
    sshConnectionId = null,
    ...rest
  } = options;

  const sshConnection = sshConnectionId ? getSshConnection(sshConnectionId) : null;

  if (sshConnection) {
    const result = await runPhpOverSsh(code, {
      ...rest,
      ssh: { ...sshConnection, enabled: true },
      onStdout: (chunk) => {
        if (!event.sender.isDestroyed())
          event.sender.send("php:stdout", { tabId, chunk });
      },
      onStderr: (chunk) => {
        if (!event.sender.isDestroyed())
          event.sender.send("php:stderr", { tabId, chunk });
      },
    });

    return { ...result, tabId };
  }

  const ctx = await resolveProject(projectPath);

  if (ctx.invalidPath && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("php:warning", {
      tabId,
      message: `Project no longer valid: ${ctx.invalidPath} — running without autoload`,
    });
  }

  const result = await runPhp(code, {
    ...rest,
    phpPath: await requirePhpRuntime(),
    mode: ctx.mode,
    autoloadPath: ctx.autoloadPath,
    bootstrapPath: ctx.bootstrapPath,
    cwd: ctx.projectPath || undefined,
    onStdout: (chunk) => {
      if (!event.sender.isDestroyed())
        event.sender.send("php:stdout", { tabId, chunk });
    },
    onStderr: (chunk) => {
      if (!event.sender.isDestroyed())
        event.sender.send("php:stderr", { tabId, chunk });
    },
  });

  return { ...result, tabId };
});

ipcMain.handle("php:version", async () => {
  return phpRuntime.get();
});

ipcMain.handle("runtime:getPhp", async () => phpRuntime.get());

ipcMain.handle("runtime:detectPhp", async () => phpRuntime.rescan());

ipcMain.handle("runtime:setPhpPath", async (_event, phpPath) => {
  return phpRuntime.setPath(phpPath);
});

ipcMain.handle("runtime:pickPhp", async () => {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    title: "Select the PHP executable",
    properties: ["openFile"],
    buttonLabel: "Use this PHP",
  });
  if (result.canceled || !result.filePaths?.length) {
    return { cancelled: true };
  }
  return phpRuntime.setPath(result.filePaths[0]);
});

// js:run mirrors php:run — same tabId/projectPath options, but no SSH path
// (JS over SSH would need a node binary on the remote, kept out of scope).
ipcMain.handle("js:run", async (event, code, options = {}) => {
  const { tabId = null, projectPath = null, ...rest } = options;
  const result = await runJs(code, {
    ...rest,
    nodePath: process.execPath,
    env: bundledNodeEnv,
    projectPath: projectPath || undefined,
    onStdout: (chunk) => {
      if (!event.sender.isDestroyed())
        event.sender.send("js:stdout", { tabId, chunk });
    },
    onStderr: (chunk) => {
      if (!event.sender.isDestroyed())
        event.sender.send("js:stderr", { tabId, chunk });
    },
  });
  return { ...result, tabId };
});

ipcMain.handle("js:version", async () => {
  return getNodeVersion(process.execPath, { env: bundledNodeEnv });
});
ipcMain.handle("ssh:test", async (_e, ssh) => {
  return testSshConnection(ssh);
});

ipcMain.handle("ssh:list", () => {
  return getSshConnections();
});
ipcMain.handle("ssh:save", (_e, conn) => {
  try {
    const normalized = normalizeSshConfig(conn);
    const validationError = validateSshConfig(normalized);
    if (validationError) return { ok: false, error: validationError };
    return { ok: true, connection: saveSshConnection({ ...conn, ...normalized }) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle("ssh:delete", (_e, id) => {
  deleteSshConnection(id);
  return { ok: true };
});

// Project handlers
ipcMain.handle("project:validate", async (_e, projectPath) => {
  return validateProject(projectPath);
});
ipcMain.handle("project:resolve", async (_e, projectPath) => {
  return resolveProject(projectPath);
});

ipcMain.handle("project:pickFolder", async () => {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    title: "Select PHP project folder",
    properties: ["openDirectory"],
    buttonLabel: "Use this project",
  });
  if (result.canceled || !result.filePaths?.length) return null;
  return result.filePaths[0];
});

// Class cache handlers — all keyed by projectPath now.
ipcMain.handle("classes:ensure", async (_e, projectPath) => {
  if (!projectPath) return null;
  return ensureScan(projectPath);
});

ipcMain.handle("classes:get", async (_e, projectPath) => {
  if (!projectPath) return null;
  return getCachedScan(projectPath);
});

ipcMain.handle("classes:rescan", async (_e, projectPath) => {
  if (!projectPath) return null;
  return ensureScan(projectPath, { force: true });
});

/* Remote class scan (over SSH). Cached in the same in-memory map under
   a synthetic key so the renderer's per-tab classCache plumbing is reused. */

const activeRemoteScans = new Map(); // cacheKey -> Promise

async function ensureRemoteScan(connectionId, { force = false } = {}) {
  if (!connectionId) return null;
  const conn = getSshConnection(connectionId);
  if (!conn || !conn.host) return null;
  if (!conn.projectPath) return null;

  const key = remoteCacheKey(conn);

  if (!force) {
    const inMem = getCachedScan(key, { maxAgeMs: CACHE_TTL_MS });
    if (inMem) return inMem;
  }

  if (activeRemoteScans.has(key) && !force) {
    return activeRemoteScans.get(key);
  }

  const promise = (async () => {
    broadcastScanProgress(key, { phase: "reading", count: 0 });
    const scan = await scanRemoteClasses(conn, {
      onProgress: (p) => broadcastScanProgress(key, p),
    });
    setCachedScan(key, scan);
    return scan;
  })();

  activeRemoteScans.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    broadcastScanProgress(key, { phase: "error", count: 0 });
    throw error;
  } finally {
    activeRemoteScans.delete(key);
  }
}

ipcMain.handle("classes:ensureRemote", async (_e, connectionId, options = {}) => {
  if (!connectionId) return null;
  const { silent = false } = options || {};
  try {
    return await ensureRemoteScan(connectionId);
  } catch (err) {
    // Background/auto scans (e.g. on app start, tab activation) shouldn't
    // toast the user — autocomplete is non-essential and a missing remote
    // host shouldn't generate a warning every launch. Only user-initiated
    // calls pass silent=false to surface failure.
    if (!silent && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("php:warning", {
        tabId: null,
        message: `Remote class scan failed: ${err?.message || err}`,
      });
    }
    return null;
  }
});

ipcMain.handle("classes:getRemote", async (_e, connectionId) => {
  if (!connectionId) return null;
  const conn = getSshConnection(connectionId);
  if (!conn) return null;
  return getCachedScan(remoteCacheKey(conn), { maxAgeMs: CACHE_TTL_MS });
});

ipcMain.handle("classes:rescanRemote", async (_e, connectionId) => {
  if (!connectionId) return null;
  try {
    return await ensureRemoteScan(connectionId, { force: true });
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("php:warning", {
        tabId: null,
        message: `Remote class scan failed: ${err?.message || err}`,
      });
    }
    return null;
  }
});

// Tab persistence
ipcMain.handle("store:getTabs", () => {
  return getTabs();
});
ipcMain.handle("store:setTabs", (_e, tabs) => {
  return setTabs(tabs);
});
ipcMain.handle("store:getActiveTabId", () => {
  return getActiveTabId();
});
ipcMain.handle("store:setActiveTabId", (_e, id) => {
  setActiveTabId(id);
});

// Misc store
ipcMain.handle("store:getRecentProjects", () => {
  return getRecentProjects();
});
ipcMain.handle("store:addRecentProject", (_e, p) => {
  return addRecentProject(p);
});
ipcMain.handle("store:getPhpPath", () => {
  return getPhpPath();
});
ipcMain.handle("store:setPhpPath", async (_e, p) => phpRuntime.setPath(p));

app.whenReady().then(async () => {
  const [phpInfo, nodeInfo] = await Promise.all([
    phpRuntime.initialize(),
    getNodeVersion(process.execPath, { env: bundledNodeEnv }),
  ]);
  if (phpInfo.version) console.log(`[phptinker] PHP detected: ${phpInfo.version}`);
  else console.warn(`[phptinker] PHP not available: ${phpInfo.error}`);
  if (nodeInfo.version) console.log(`[phptinker] Node detected: ${nodeInfo.version}`);
  else console.warn(`[phptinker] Node not available: ${nodeInfo.error}`);
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
