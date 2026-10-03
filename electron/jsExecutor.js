import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024

function normalizeOutputLimit(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return MAX_EXEC_OUTPUT_BYTES
  return Math.min(MAX_EXEC_OUTPUT_BYTES, Math.max(1024, Math.trunc(parsed)))
}

function takeUtf8Chunk(chunk, remainingBytes) {
  if (remainingBytes <= 0) return ''
  const bytes = Buffer.from(chunk, 'utf8')
  if (bytes.length <= remainingBytes) return chunk
  return bytes.subarray(0, remainingBytes).toString('utf8')
}

/* ------------------------------------------------------------------ */
/* Last-expression detection (mirror of executor.js wrapLastExpression) */
/* ------------------------------------------------------------------ */

// Anything starting with one of these is treated as a statement, not an
// expression to capture. Mostly mirrors the PHP detector adapted for JS.
const RESERVED_STARTS = /^(if|else|for|while|do|switch|case|default|function|async\s+function|class|return|throw|try|catch|finally|break|continue|var|let|const|export|import|yield|await\s+(?:function|class)|debugger)\b/

function stripTrailingComment(line) {
  // Best-effort: strip a trailing // comment (not inside a string). Cheap
  // heuristic — fine for "type an expression" REPL ergonomics.
  const idx = line.indexOf('//')
  if (idx === -1) return line
  // Don't strip if // appears inside a string literal — give up and leave it.
  const before = line.slice(0, idx)
  const dq = (before.match(/"/g) || []).length
  const sq = (before.match(/'/g) || []).length
  const tq = (before.match(/`/g) || []).length
  if (dq % 2 || sq % 2 || tq % 2) return line
  return before
}

function findLastExpression(code) {
  // Walk backwards from the end, splitting on the last meaningful `;` or
  // newline boundary. JS allows ASI, so the last expression isn't always
  // semicolon-terminated.
  let trimmed = code.replace(/\s+$/, '')
  if (!trimmed) return { prefix: '', expr: '' }

  // Strip a trailing semicolon if present; we'll add one back as needed.
  let trailingSemi = false
  if (trimmed.endsWith(';')) {
    trailingSemi = true
    trimmed = trimmed.slice(0, -1).replace(/\s+$/, '')
  }

  // Find the boundary of the last "logical line". This is naive: we pick
  // the last `;` or `\n` that isn't inside braces/parens/brackets/quotes.
  let depth = 0
  let inSingle = false, inDouble = false, inBack = false, inLineComment = false, inBlockComment = false
  let lastBoundary = -1
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]
    const next = trimmed[i + 1]
    if (inLineComment) {
      if (c === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++ }
      continue
    }
    if (inSingle) { if (c === '\\') i++; else if (c === "'") inSingle = false; continue }
    if (inDouble) { if (c === '\\') i++; else if (c === '"') inDouble = false; continue }
    if (inBack)   { if (c === '\\') i++; else if (c === '`')  inBack  = false; continue }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (c === "'") { inSingle = true; continue }
    if (c === '"') { inDouble = true; continue }
    if (c === '`') { inBack = true; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (c === ';' || c === '\n')) lastBoundary = i
  }

  let prefix, expr
  if (lastBoundary === -1) {
    prefix = ''
    expr = trimmed
  } else {
    prefix = trimmed.slice(0, lastBoundary + 1)
    expr = trimmed.slice(lastBoundary + 1).replace(/^\s+/, '')
  }

  // Strip a trailing line comment from the expression itself, e.g.
  // `nums.sum(); // result` after we already shaved the `;`.
  expr = stripTrailingComment(expr).trimEnd()

  return { prefix, expr, trailingSemi }
}

function shouldCaptureLast(expr) {
  if (!expr) return false
  if (RESERVED_STARTS.test(expr)) return false
  if (expr.startsWith('{') || expr.startsWith('}')) return false
  // assignment / declaration: don't capture, the user is binding.
  // We try to detect a top-level `=` that's not `==`/`===`/`<=`/`>=`/`!=`.
  return true
}

function buildProjectPreamble(projectPath) {
  // Provide a project-rooted `require`, plus absolute `__dirname` /
  // `__filename`, regardless of whether stdin is being evaluated as CJS or
  // ESM. We can't rely on the global `require` — Node 22+ stdin evaluation
  // doesn't always inject it, which is why bare `require(...)` errored. Use
  // dynamic `import('node:module')` instead; this works in both modes
  // because we're already inside an async IIFE.
  const rootExpr = projectPath ? JSON.stringify(projectPath) : 'process.cwd()'
  return `const { createRequire: __phptinker_createRequire } = await import('node:module');
const __phptinker_path_mod = await import('node:path');
const __phptinker_path = __phptinker_path_mod.default || __phptinker_path_mod;
const __phptinker_project_root = ${rootExpr};
const __dirname = __phptinker_project_root;
const __filename = __phptinker_path.join(__phptinker_project_root, '[scratch].js');
const require = __phptinker_createRequire(__phptinker_path.join(__phptinker_project_root, 'package.json'));
`
}

function wrapInAsyncIife(userCode, projectPath) {
  const { prefix, expr } = findLastExpression(userCode)
  const preamble = buildProjectPreamble(projectPath)

  // Important: util is required inside the runtime so the user doesn't have
  // to import it. We also stringify with depth=4 / colors=false / breakLength=80
  // — sane defaults for a scratchpad pretty-printer.
  if (shouldCaptureLast(expr)) {
    return `(async () => {
${preamble}
${prefix}
const __phptinker_result = (${expr});
const __phptinker_resolved = (__phptinker_result && typeof __phptinker_result.then === 'function')
  ? await __phptinker_result
  : __phptinker_result;
if (typeof __phptinker_resolved !== 'undefined') {
  process.stdout.write('=> ' + require('util').inspect(__phptinker_resolved, { depth: 4, colors: false, breakLength: 80 }) + '\\n');
}
})().catch((__phptinker_err) => {
  if (__phptinker_err && __phptinker_err.stack) process.stderr.write(__phptinker_err.stack + '\\n');
  else process.stderr.write(String(__phptinker_err) + '\\n');
  process.exitCode = 1;
});
`
  }

  return `(async () => {
${preamble}
${userCode}
})().catch((__phptinker_err) => {
  if (__phptinker_err && __phptinker_err.stack) process.stderr.write(__phptinker_err.stack + '\\n');
  else process.stderr.write(String(__phptinker_err) + '\\n');
  process.exitCode = 1;
});
`
}

function buildScript(userCode, projectPath) {
  // Node defaults to CommonJS for stdin/`-` input. Inside the async IIFE,
  // top-level `await` works because we're inside an async function.
  return wrapInAsyncIife(userCode, projectPath)
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Execute JS code via the user's Node binary. Stream stdout/stderr as they
 * arrive. The script is wrapped in an async IIFE so users get top-level
 * `await` support, and the last expression (when one exists) is captured
 * and printed via util.inspect — same UX as the PHP executor.
 *
 * Setting cwd to the project path lets `require('lodash')` resolve from the
 * project's local node_modules. No bootstrapping needed beyond that.
 *
 * @param {string} code
 * @param {object} [options]
 * @param {string} [options.nodePath='node']
 * @param {string} [options.projectPath]            Used as cwd if provided.
 * @param {number} [options.timeoutMs=30000]
 * @param {(chunk: string) => void} [options.onStdout]
 * @param {(chunk: string) => void} [options.onStderr]
 */
export async function runJs(code, options = {}) {
  const {
    nodePath = 'node',
    projectPath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onStdout,
    onStderr,
    maxOutputBytes = MAX_EXEC_OUTPUT_BYTES,
    env,
  } = options

  const start = performance.now()
  const script = buildScript(code, projectPath)

  return new Promise((resolve) => {
    let child
    try {
      // Reading from stdin is what `node -` does. We pipe the script there
      // so we don't have to deal with argv length limits or shell escaping.
      child = spawn(nodePath, ['-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: projectPath || undefined,
        env: env || process.env,
      })
    } catch (err) {
      resolve({
        stdout: '',
        stderr: `Node binary not found at: ${nodePath}`,
        exitCode: -1,
        durationMs: 0,
        timedOut: false,
        mode: 'js',
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let outputLimited = false
    let outputBytes = 0
    let settled = false
    const outputLimit = normalizeOutputLimit(maxOutputBytes)

    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs: Math.round(performance.now() - start),
        timedOut,
        outputLimited,
        mode: 'js',
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk) => {
      const accepted = takeUtf8Chunk(chunk, outputLimit - outputBytes)
      if (accepted) {
        outputBytes += Buffer.byteLength(accepted, 'utf8')
        stdout += accepted
        if (onStdout) onStdout(accepted)
      }
      if (!outputLimited && Buffer.byteLength(chunk, 'utf8') > Buffer.byteLength(accepted, 'utf8')) {
        outputLimited = true
        const message = `\n[execution stopped: ${outputLimit} byte output limit reached]\n`
        stderr += message
        if (onStderr) onStderr(message)
        try { child.kill('SIGKILL') } catch {}
      }
    })

    child.stderr.on('data', (chunk) => {
      const accepted = takeUtf8Chunk(chunk, outputLimit - outputBytes)
      if (accepted) {
        outputBytes += Buffer.byteLength(accepted, 'utf8')
        stderr += accepted
        if (onStderr) onStderr(accepted)
      }
      if (!outputLimited && Buffer.byteLength(chunk, 'utf8') > Buffer.byteLength(accepted, 'utf8')) {
        outputLimited = true
        const message = `\n[execution stopped: ${outputLimit} byte output limit reached]\n`
        stderr += message
        if (onStderr) onStderr(message)
        try { child.kill('SIGKILL') } catch {}
      }
    })

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        stderr = `Node binary not found at: ${nodePath}`
      } else {
        stderr += `\n[spawn error] ${err.message}`
      }
      finish(-1)
    })

    child.on('close', (code) => {
      finish(code ?? -1)
    })

    child.stdin.on('error', (err) => {
      stderr += `\n[stdin error] ${err.message}`
      finish(-1)
    })

    try {
      child.stdin.write(script)
      child.stdin.end()
    } catch {
      // child.on('error') will resolve.
    }
  })
}

/**
 * Probe `node -v` for the user's Node version.
 */
export async function getNodeVersion(nodePath = 'node', { env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(nodePath, ['-v'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env || process.env,
      })
    } catch (err) {
      resolve({ version: null, path: nodePath, error: err.message })
      return
    }

    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })

    child.on('error', (e) => {
      resolve({
        version: null,
        path: nodePath,
        error: e.code === 'ENOENT' ? `Node binary not found at: ${nodePath}` : e.message,
      })
    })

    child.on('close', (code) => {
      if (code === 0 && out) {
        resolve({ version: out.trim(), path: nodePath })
      } else {
        resolve({
          version: null,
          path: nodePath,
          error: (err || out || `node -v exited with code ${code}`).trim(),
        })
      }
    })
  })
}
