import { spawn } from 'node:child_process'
import { constants as fsConstants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_PROBE_TIMEOUT_MS = 5_000
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024

function platformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

function addCandidate(list, seen, candidate, source, platform) {
  if (typeof candidate !== 'string') return
  const trimmed = candidate.trim()
  if (!trimmed) return

  const key = platform === 'win32' ? trimmed.toLowerCase() : trimmed
  if (seen.has(key)) return
  seen.add(key)
  list.push({ path: trimmed, source })
}

export function phpCandidates({
  savedPath = null,
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const paths = platformPath(platform)
  const candidates = []
  const seen = new Set()

  if (typeof savedPath === 'string' && paths.isAbsolute(savedPath.trim())) {
    addCandidate(candidates, seen, savedPath, 'saved', platform)
  }

  const pathValue = typeof env.PATH === 'string' ? env.PATH : ''
  const delimiter = platform === 'win32' ? ';' : ':'
  const executableNames = platform === 'win32'
    ? ['php.exe', 'php.cmd', 'php.bat']
    : ['php']

  for (const directory of pathValue.split(delimiter)) {
    const cleanDirectory = directory.trim().replace(/^"|"$/g, '')
    if (!cleanDirectory || !paths.isAbsolute(cleanDirectory)) continue
    for (const executable of executableNames) {
      addCandidate(
        candidates,
        seen,
        paths.join(cleanDirectory, executable),
        'path',
        platform,
      )
    }
  }

  const known = []
  if (platform === 'darwin') {
    if (homeDir) {
      known.push(paths.join(homeDir, 'Library', 'Application Support', 'Herd', 'bin', 'php'))
    }
    known.push('/opt/homebrew/bin/php', '/usr/local/bin/php', '/usr/bin/php')
  } else if (platform === 'win32') {
    if (env.USERPROFILE) {
      known.push(paths.join(env.USERPROFILE, '.config', 'herd', 'bin', 'php.exe'))
    }
    if (env.LOCALAPPDATA) {
      known.push(paths.join(env.LOCALAPPDATA, 'Programs', 'PHP', 'php.exe'))
    }
    if (env.ProgramFiles) {
      known.push(paths.join(env.ProgramFiles, 'PHP', 'php.exe'))
    }
    known.push('C:\\php\\php.exe', 'C:\\xampp\\php\\php.exe')
  } else {
    if (homeDir) known.push(paths.join(homeDir, '.config', 'herd', 'bin', 'php'))
    known.push('/usr/local/bin/php', '/usr/bin/php', '/snap/bin/php')
  }

  for (const candidate of known) {
    addCandidate(candidates, seen, candidate, 'known-location', platform)
  }

  return candidates
}

export async function probePhpBinary(
  phpPath,
  {
    spawnImpl = spawn,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    platform = process.platform,
  } = {},
) {
  const candidate = typeof phpPath === 'string' ? phpPath.trim() : ''
  const paths = platformPath(platform)
  if (!candidate) {
    return { ok: false, path: null, version: null, error: 'PHP path is required' }
  }
  if (!paths.isAbsolute(candidate)) {
    return {
      ok: false,
      path: candidate,
      version: null,
      error: 'Choose the absolute path to the PHP executable',
    }
  }

  try {
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) {
      return { ok: false, path: candidate, version: null, error: 'PHP path must point to a file' }
    }
    await fs.access(
      candidate,
      platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK,
    )
  } catch {
    return {
      ok: false,
      path: candidate,
      version: null,
      error: `PHP executable not found or not executable: ${candidate}`,
    }
  }

  return new Promise((resolve) => {
    let child
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    try {
      child = spawnImpl(candidate, ['-v'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({
        ok: false,
        path: candidate,
        version: null,
        error: error?.message || String(error),
      })
      return
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({
        ok: false,
        path: candidate,
        version: null,
        error: 'PHP version check timed out',
      })
    }, timeoutMs)

    const capture = (target, chunk) => {
      const next = target + chunk
      if (Buffer.byteLength(next, 'utf8') > MAX_PROBE_OUTPUT_BYTES) {
        try { child.kill('SIGKILL') } catch {}
        finish({
          ok: false,
          path: candidate,
          version: null,
          error: 'PHP version check produced too much output',
        })
        return target
      }
      return next
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk) })

    child.on('error', (error) => {
      finish({
        ok: false,
        path: candidate,
        version: null,
        error: error?.code === 'ENOENT'
          ? `PHP executable not found: ${candidate}`
          : error?.message || String(error),
      })
    })

    child.on('close', (code) => {
      const version = stdout.split(/\r?\n/, 1)[0].trim()
      if (code === 0 && /^PHP\s+\d+(?:\.\d+)+/i.test(version)) {
        finish({ ok: true, path: candidate, version })
        return
      }
      finish({
        ok: false,
        path: candidate,
        version: null,
        error: (stderr || stdout || `PHP exited with code ${code}`).trim(),
      })
    })
  })
}

export async function validatePhpBinary(phpPath, { probe = probePhpBinary } = {}) {
  const candidate = typeof phpPath === 'string' ? phpPath.trim() : ''
  if (!candidate) {
    return { ok: false, path: null, version: null, error: 'PHP path is required' }
  }
  if (!path.isAbsolute(candidate)) {
    return {
      ok: false,
      path: candidate,
      version: null,
      error: 'Choose the absolute path to the PHP executable',
    }
  }

  const result = await probe(candidate)
  return result?.ok
    ? { ok: true, path: result.path || candidate, version: result.version }
    : {
        ok: false,
        path: candidate,
        version: null,
        error: result?.error || 'Selected file is not a working PHP executable',
      }
}

export async function detectPhpBinary({
  savedPath = null,
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  probe = probePhpBinary,
} = {}) {
  for (const candidate of phpCandidates({ savedPath, platform, env, homeDir })) {
    const result = await probe(candidate.path)
    if (result?.ok) {
      return {
        ok: true,
        path: result.path || candidate.path,
        version: result.version,
        source: candidate.source,
      }
    }
  }

  return {
    ok: false,
    path: null,
    version: null,
    error: 'PHP Tinker could not find PHP. Choose the PHP executable in Runtime Settings.',
  }
}
