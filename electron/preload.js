import { contextBridge, ipcRenderer } from 'electron'

const api = {
  runPhp: (code, options) => ipcRenderer.invoke('php:run', code, options),
  getPhpVersion: () => ipcRenderer.invoke('php:version'),

  runtime: {
    getPhp: () => ipcRenderer.invoke('runtime:getPhp'),
    detectPhp: () => ipcRenderer.invoke('runtime:detectPhp'),
    setPhpPath: (path) => ipcRenderer.invoke('runtime:setPhpPath', path),
    pickPhp: () => ipcRenderer.invoke('runtime:pickPhp'),
  },

  runJs: (code, options) => ipcRenderer.invoke('js:run', code, options),
  getNodeVersion: () => ipcRenderer.invoke('js:version'),

  // Stream events now carry { tabId, chunk } so the renderer routes
  // output to the correct tab regardless of which tab is active.
  onStdout: (callback) => {
    const listener = (_e, payload) => callback(payload)
    ipcRenderer.on('php:stdout', listener)
    return () => ipcRenderer.removeListener('php:stdout', listener)
  },

  onStderr: (callback) => {
    const listener = (_e, payload) => callback(payload)
    ipcRenderer.on('php:stderr', listener)
    return () => ipcRenderer.removeListener('php:stderr', listener)
  },

  onJsStdout: (callback) => {
    const listener = (_e, payload) => callback(payload)
    ipcRenderer.on('js:stdout', listener)
    return () => ipcRenderer.removeListener('js:stdout', listener)
  },

  onJsStderr: (callback) => {
    const listener = (_e, payload) => callback(payload)
    ipcRenderer.on('js:stderr', listener)
    return () => ipcRenderer.removeListener('js:stderr', listener)
  },

  onWarning: (callback) => {
    const listener = (_e, payload) => callback(payload)
    ipcRenderer.on('php:warning', listener)
    return () => ipcRenderer.removeListener('php:warning', listener)
  },

  project: {
    pickFolder: () => ipcRenderer.invoke('project:pickFolder'),
    validate: (path) => ipcRenderer.invoke('project:validate', path),
    resolve: (path) => ipcRenderer.invoke('project:resolve', path),
  },

  classes: {
    ensure: (projectPath) => ipcRenderer.invoke('classes:ensure', projectPath),
    get: (projectPath) => ipcRenderer.invoke('classes:get', projectPath),
    rescan: (projectPath) => ipcRenderer.invoke('classes:rescan', projectPath),
    ensureRemote: (connectionId, options) => ipcRenderer.invoke('classes:ensureRemote', connectionId, options),
    getRemote: (connectionId) => ipcRenderer.invoke('classes:getRemote', connectionId),
    rescanRemote: (connectionId) => ipcRenderer.invoke('classes:rescanRemote', connectionId),
    onScanProgress: (callback) => {
      const listener = (_e, progress) => callback(progress)
      ipcRenderer.on('classes:scanProgress', listener)
      return () => ipcRenderer.removeListener('classes:scanProgress', listener)
    },
  },

  ssh: {
    list: () => ipcRenderer.invoke('ssh:list'),
    save: (connection) => ipcRenderer.invoke('ssh:save', connection),
    remove: (id) => ipcRenderer.invoke('ssh:delete', id),
    test: (connection) => ipcRenderer.invoke('ssh:test', connection),
  },

  store: {
    getTabs: () => ipcRenderer.invoke('store:getTabs'),
    setTabs: (tabs) => ipcRenderer.invoke('store:setTabs', tabs),
    getActiveTabId: () => ipcRenderer.invoke('store:getActiveTabId'),
    setActiveTabId: (id) => ipcRenderer.invoke('store:setActiveTabId', id),

    getRecentProjects: () => ipcRenderer.invoke('store:getRecentProjects'),
    addRecentProject: (path) => ipcRenderer.invoke('store:addRecentProject', path),
    getPhpPath: () => ipcRenderer.invoke('store:getPhpPath'),
    setPhpPath: (path) => ipcRenderer.invoke('store:setPhpPath', path),
  },
}

contextBridge.exposeInMainWorld('api', api)
