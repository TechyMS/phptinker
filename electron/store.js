import Store from "electron-store";
import { app } from "electron";
import path from "node:path";
import { secureDirectory, secureFile } from "./privateStorage.js";
import { randomUUID } from "node:crypto";

const STARTER_BUFFER = "$numbers = [1, 2, 3, 4, 5];\narray_sum($numbers);";
const RECENT_MAX = 5;

const DEFAULTS = {
  phpPath: "php",
  recentProjects: [],
  tabs: [],
  activeTabId: null,
  sshConnections: [],
};

const userData = app.getPath("userData");
secureDirectory(userData);
secureFile(path.join(userData, "phptinker.json"));
export const store = new Store({
  name: "phptinker",
  defaults: DEFAULTS,
  configFileMode: 0o600,
});

function makeTab({
  buffer = STARTER_BUFFER,
  projectPath = null,
  title = "",
  language = "php",
} = {}) {
  return {
    id: randomUUID(),
    title,
    buffer,
    projectPath,
    sshConnectionId: null,
    titleIsCustom: false,
    language,
  };
}

function defaultConnection() {
  return {
    id: randomUUID(),
    name: "",
    host: "",
    user: "",
    port: 22,
    identityFile: "",
    phpPath: "php",
    projectPath: "",
    mode: "raw",
  };
}

function sanitizeConnection(c, { generateId = true } = {}) {
  const port = Number.parseInt(c?.port, 10);
  const id =
    typeof c?.id === "string" && c.id ? c.id : generateId ? randomUUID() : null;
  return {
    id,
    name: typeof c?.name === "string" ? c.name.trim() : "",
    host: typeof c?.host === "string" ? c.host.trim() : "",
    user: typeof c?.user === "string" ? c.user.trim() : "",
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
    identityFile:
      typeof c?.identityFile === "string" ? c.identityFile.trim() : "",
    phpPath:
      typeof c?.phpPath === "string" && c.phpPath.trim()
        ? c.phpPath.trim()
        : "php",
    projectPath: typeof c?.projectPath === "string" ? c.projectPath.trim() : "",
    mode: ["raw", "composer", "laravel"].includes(c?.mode) ? c.mode : "raw",
  };
}

/* ------------------------------------------------------------------ */
/* Migration                                                          */
/*                                                                    */
/* (1) legacy single-buffer state (`buffer`/`projectPath`)             */
/* (2) per-tab inline sshConfig → global sshConnections + per-tab      */
/*     sshConnectionId pointer.                                        */
/* Idempotent. Safe to re-run.                                         */
/* ------------------------------------------------------------------ */

function migrateLegacyState() {
  // These keys belonged to the discontinued commercial license flow. They
  // are never needed by the open-source desktop app and may contain stale
  // installation identifiers from older builds.
  for (const key of [
    "licenseCertificate",
    "licenseClockHighWatermark",
    "licenseInstallId",
    "licenseServerUrl",
  ]) {
    if (store.has(key)) store.delete(key);
  }

  const tabs = store.get("tabs");
  if (!Array.isArray(tabs) || tabs.length === 0) {
    const legacyBuffer = store.has("buffer") ? store.get("buffer") : null;
    const legacyProjectPath = store.has("projectPath")
      ? store.get("projectPath")
      : null;
    let tab;
    if (legacyBuffer != null || legacyProjectPath != null) {
      tab = makeTab({
        buffer:
          typeof legacyBuffer === "string" ? legacyBuffer : STARTER_BUFFER,
        projectPath: legacyProjectPath || null,
      });
    } else {
      tab = makeTab();
    }
    store.set("tabs", [tab]);
    store.set("activeTabId", tab.id);
    if (store.has("buffer")) store.delete("buffer");
    if (store.has("projectPath")) store.delete("projectPath");
  }

  // Migrate inline sshConfig → connections list.
  const currentTabs = store.get("tabs") || [];
  const existing = Array.isArray(store.get("sshConnections"))
    ? store.get("sshConnections")
    : [];
  const connections = [...existing];
  const seenKey = new Map(connections.map((c) => [connectionKey(c), c.id]));
  let mutated = false;

  const migratedTabs = currentTabs.map((t) => {
    if (!t || typeof t !== "object") return t;
    if (t.sshConnectionId || !t.sshConfig) return t;

    const cfg = t.sshConfig;
    if (cfg && cfg.enabled && cfg.host) {
      const candidate = sanitizeConnection({
        ...cfg,
        name: cfg.host || "Server",
      });
      const key = connectionKey(candidate);
      let id = seenKey.get(key);
      if (!id) {
        id = candidate.id;
        connections.push(candidate);
        seenKey.set(key, id);
      }
      mutated = true;
      const { sshConfig, ...rest } = t;
      return { ...rest, sshConnectionId: id };
    }

    if (cfg) {
      mutated = true;
      const { sshConfig, ...rest } = t;
      return { ...rest, sshConnectionId: null };
    }
    return t;
  });

  if (mutated) {
    store.set("tabs", migratedTabs);
    store.set("sshConnections", connections);
  }
}

function connectionKey(c) {
  return [
    c.host,
    c.user,
    c.port,
    c.identityFile,
    c.projectPath,
    c.mode,
    c.phpPath,
  ].join("|");
}

migrateLegacyState();

/* ------------------------------------------------------------------ */
/* Tabs                                                               */
/* ------------------------------------------------------------------ */

function ensureAtLeastOneTab(tabs) {
  if (Array.isArray(tabs) && tabs.length > 0) return tabs;
  return [makeTab()];
}

function sanitizeTab(t) {
  const language = t?.language === "js" ? "js" : "php";
  return {
    id: typeof t?.id === "string" && t.id ? t.id : randomUUID(),
    title: typeof t?.title === "string" ? t.title : "",
    buffer: typeof t?.buffer === "string" ? t.buffer : "",
    projectPath:
      typeof t?.projectPath === "string" && t.projectPath
        ? t.projectPath
        : null,
    sshConnectionId:
      typeof t?.sshConnectionId === "string" && t.sshConnectionId
        ? t.sshConnectionId
        : null,
    titleIsCustom: !!t?.titleIsCustom,
    language,
  };
}

export function getTabs() {
  const tabs = store.get("tabs");
  const safe = ensureAtLeastOneTab(
    Array.isArray(tabs) ? tabs.map(sanitizeTab) : [],
  );
  if (safe !== tabs) store.set("tabs", safe);
  return safe;
}

export function setTabs(tabs) {
  const safe = ensureAtLeastOneTab(
    Array.isArray(tabs) ? tabs.map(sanitizeTab) : [],
  );
  store.set("tabs", safe);

  const activeId = store.get("activeTabId");
  if (!activeId || !safe.some((t) => t.id === activeId)) {
    store.set("activeTabId", safe[0].id);
  }
  return safe;
}

export function getActiveTabId() {
  const id = store.get("activeTabId");
  const tabs = getTabs();
  if (id && tabs.some((t) => t.id === id)) return id;
  store.set("activeTabId", tabs[0].id);
  return tabs[0].id;
}

export function setActiveTabId(id) {
  if (typeof id !== "string" || !id) return;
  store.set("activeTabId", id);
}

/* ------------------------------------------------------------------ */
/* SSH connections (global, named, reusable)                          */
/* ------------------------------------------------------------------ */

export function getSshConnections() {
  const list = store.get("sshConnections");
  return Array.isArray(list)
    ? list
        .map((c) => sanitizeConnection(c, { generateId: false }))
        .filter((c) => c.id)
    : [];
}

export function getSshConnection(id) {
  if (!id) return null;
  return getSshConnections().find((c) => c.id === id) || null;
}

export function saveSshConnection(connection) {
  const list = getSshConnections();
  const incoming = sanitizeConnection(connection);
  if (!incoming.host) {
    throw new Error("Host is required");
  }
  if (!incoming.name) {
    incoming.name = incoming.user
      ? `${incoming.user}@${incoming.host}`
      : incoming.host;
  }
  const idx = list.findIndex((c) => c.id === incoming.id);
  if (idx >= 0) {
    list[idx] = incoming;
  } else {
    list.push(incoming);
  }
  store.set("sshConnections", list);
  return incoming;
}

export function deleteSshConnection(id) {
  if (!id) return getSshConnections();
  const next = getSshConnections().filter((c) => c.id !== id);
  store.set("sshConnections", next);

  // Detach any tabs pointing at the deleted connection.
  const tabs = (store.get("tabs") || []).map((t) =>
    t && t.sshConnectionId === id ? { ...t, sshConnectionId: null } : t,
  );
  store.set("tabs", tabs);
  return next;
}

/* ------------------------------------------------------------------ */
/* PHP path / recents (unchanged)                                     */
/* ------------------------------------------------------------------ */

export const getPhpPath = () => {
  const value = store.get("phpPath", DEFAULTS.phpPath);
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULTS.phpPath;
};

export const setPhpPath = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("PHP path is required");
  }
  store.set("phpPath", value.trim());
  return value.trim();
};



export const getRecentProjects = () => store.get("recentProjects", []);

export const addRecentProject = (path) => {
  if (!path) return getRecentProjects();
  const current = getRecentProjects().filter((p) => p !== path);
  const next = [path, ...current].slice(0, RECENT_MAX);
  store.set("recentProjects", next);
  return next;
};
