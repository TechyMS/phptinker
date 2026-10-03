import { mkdirSync, chmodSync, existsSync, lstatSync } from 'node:fs'

export function secureDirectory(directory) {
  mkdirSync(directory, {recursive: true, mode: 0o700})
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Private storage directory cannot be a symlink')
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
}

export function secureFile(file) {
  if (!existsSync(file)) return
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Private storage must be a regular file')
  if (process.platform !== 'win32') chmodSync(file, 0o600)
}
