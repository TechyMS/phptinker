import { spawn } from 'node:child_process'
import { readBoundedFile } from './boundedFile.js'
import { performance } from 'node:perf_hooks'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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
/* Prelude fragments                                                  */
/* ------------------------------------------------------------------ */

// The exception handler unwraps the $previous chain (common with Laravel's
// nested DB exceptions), prints the SQL/bindings on QueryException, and
// truncates each frame's trace to 8 lines.
const BASE_PRELUDE = `function __phptinker_format_throwable(\\Throwable $e, int $depth = 0): string {
    $indent = str_repeat('  ', $depth);
    $head   = sprintf('%s%s: %s', $indent, get_class($e), $e->getMessage());
    $loc    = sprintf('%s  in %s:%d', $indent, $e->getFile(), $e->getLine());

    $extra = '';
    if ($e instanceof \\Illuminate\\Database\\QueryException) {
        $sql = method_exists($e, 'getSql') ? $e->getSql() : ($e->sql ?? null);
        $bindings = method_exists($e, 'getBindings')
            ? $e->getBindings()
            : ($e->bindings ?? []);
        if ($sql) {
            $extra .= sprintf("\\n%s  SQL: %s", $indent, $sql);
        }
        if (!empty($bindings)) {
            $extra .= sprintf(
                "\\n%s  bindings: %s",
                $indent,
                json_encode($bindings, JSON_UNESCAPED_SLASHES)
            );
        }
    }

    $trace = $e->getTrace();
    $traceLines = [];
    foreach (array_slice($trace, 0, 8) as $i => $frame) {
        $where = isset($frame['file'])
            ? $frame['file'] . ':' . ($frame['line'] ?? '?')
            : '[internal]';
        $call = '';
        if (isset($frame['class'])) {
            $call = $frame['class'] . ($frame['type'] ?? '::') . ($frame['function'] ?? '');
        } elseif (isset($frame['function'])) {
            $call = $frame['function'];
        }
        $traceLines[] = sprintf('%s    #%d %s %s', $indent, $i, $where, $call);
    }

    $out = $head . "\\n" . $loc . $extra;
    if ($traceLines) {
        $out .= "\\n" . implode("\\n", $traceLines);
    }

    if ($prev = $e->getPrevious()) {
        $out .= "\\n" . $indent . "Caused by:\\n" . __phptinker_format_throwable($prev, $depth + 1);
    }

    return $out;
}

set_exception_handler(function (\\Throwable $e) {
    fwrite(STDERR, __phptinker_format_throwable($e) . "\\n");
    exit(1);
});

function __phptinker_dump($value, int $depth = 0): string {
    $indent = str_repeat('  ', $depth);
    $next   = str_repeat('  ', $depth + 1);

    if ($value === null) return 'null';
    if (is_bool($value)) return $value ? 'true' : 'false';
    if (is_int($value) || is_float($value)) return (string) $value;
    if (is_string($value)) {
        return '"' . addcslashes($value, "\\\\\\"\\n\\r\\t") . '"';
    }

    // Laravel Eloquent collection — render as Collection [ ... ] with class
    // header so it's clearly distinguished from a plain array.
    if (\\class_exists(\\Illuminate\\Support\\Collection::class, false)
        && $value instanceof \\Illuminate\\Support\\Collection) {
        $cls   = get_class($value);
        $items = $value->all();
        if (empty($items)) return $cls . ' []';
        $lines = [];
        foreach ($items as $k => $v) {
            $key = is_int($k) ? '#' . $k : '"' . $k . '"';
            $lines[] = $next . $key . ' => ' . __phptinker_dump($v, $depth + 1);
        }
        return $cls . " [\\n" . implode(",\\n", $lines) . "\\n" . $indent . ']';
    }

    // Eloquent model — show fully qualified class name + attributes.
    if (\\class_exists(\\Illuminate\\Database\\Eloquent\\Model::class, false)
        && $value instanceof \\Illuminate\\Database\\Eloquent\\Model) {
        $cls   = get_class($value);
        $attrs = $value->attributesToArray();
        if (empty($attrs)) return $cls . ' {}';
        $lines = [];
        foreach ($attrs as $k => $v) {
            $lines[] = $next . $k . ': ' . __phptinker_dump($v, $depth + 1);
        }
        return $cls . " {\\n" . implode(",\\n", $lines) . "\\n" . $indent . '}';
    }

    if (is_array($value)) {
        if (empty($value)) return '[]';
        $isList = function_exists('array_is_list') ? array_is_list($value) : (array_keys($value) === range(0, count($value) - 1));
        $lines = [];
        foreach ($value as $k => $v) {
            $prefix = '';
            if (!$isList) {
                $prefix = (is_int($k) ? $k : '"' . $k . '"') . ' => ';
            }
            $lines[] = $next . $prefix . __phptinker_dump($v, $depth + 1);
        }
        return "[\\n" . implode(",\\n", $lines) . "\\n" . $indent . ']';
    }

    if (is_object($value)) {
        $cls = get_class($value);
        if ($value instanceof \\DateTimeInterface) {
            return $cls . ' "' . $value->format('Y-m-d H:i:s.uP') . '"';
        }
        if ($value instanceof \\Stringable || method_exists($value, '__toString')) {
            try {
                return $cls . ' "' . (string) $value . '"';
            } catch (\\Throwable $e) {
                // fall through
            }
        }
        $vars = get_object_vars($value);
        if (empty($vars)) return $cls . ' {}';
        $lines = [];
        foreach ($vars as $k => $v) {
            $lines[] = $next . $k . ': ' . __phptinker_dump($v, $depth + 1);
        }
        return $cls . " {\\n" . implode(",\\n", $lines) . "\\n" . $indent . '}';
    }

    if (is_resource($value)) {
        return 'resource(' . get_resource_type($value) . ')';
    }

    return var_export($value, true);
}

function __phptinker_capture($value) {
    echo __phptinker_dump($value) . "\\n";
}
`

// composer-only autoload (no Laravel boot).
function buildAutoloadFragment(autoloadPath) {
  if (!autoloadPath) return ''
  const escaped = phpEscape(autoloadPath)
  return `try {
    require_once '${escaped}';
} catch (\\Throwable $__phptinker_autoload_err) {
    fwrite(STDERR, "Failed to load autoload: ${escaped}\\n" . $__phptinker_autoload_err->getMessage() . "\\n");
    exit(1);
}
`
}

// Laravel: autoload + bootstrap kernel. Bootstrap errors are caught
// separately and surfaced as a clean "Failed to boot Laravel: ..." line
// — distinct from later user-code exceptions.
function buildLaravelBootFragment(autoloadPath, bootstrapPath) {
  const auto = phpEscape(autoloadPath)
  const boot = phpEscape(bootstrapPath)
  return `try {
    require_once '${auto}';
} catch (\\Throwable $__phptinker_autoload_err) {
    fwrite(STDERR, "Failed to load autoload: ${auto}\\n" . $__phptinker_autoload_err->getMessage() . "\\n");
    exit(1);
}

// Sane request defaults so framework code that touches \$_SERVER doesn't blow up.
$_SERVER['SERVER_NAME'] = $_SERVER['SERVER_NAME'] ?? 'localhost';
$_SERVER['REQUEST_URI'] = $_SERVER['REQUEST_URI'] ?? '/';
$_SERVER['HTTP_HOST']   = $_SERVER['HTTP_HOST']   ?? 'localhost';

try {
    $__phptinker_app = require '${boot}';
    $__phptinker_kernel = $__phptinker_app->make(\\Illuminate\\Contracts\\Console\\Kernel::class);
    $__phptinker_kernel->bootstrap();
} catch (\\Throwable $__phptinker_boot_err) {
    fwrite(STDERR, "Failed to boot Laravel: " . $__phptinker_boot_err->getMessage() . "\\n");
    fwrite(STDERR, "  in " . $__phptinker_boot_err->getFile() . ":" . $__phptinker_boot_err->getLine() . "\\n");
    exit(1);
}
`
}

function phpEscape(str) {
  // PHP single-quoted: only ' and \ need escaping.
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/* ------------------------------------------------------------------ */
/* Last-expression detection                                          */
/* ------------------------------------------------------------------ */

const RESERVED_STARTS = /^(<\?php|<\?=|\?>|if|else|elseif|endif|for|endfor|foreach|endforeach|while|endwhile|do|switch|endswitch|case|default|function|fn|class|interface|trait|enum|namespace|use|return|throw|echo|print|require|require_once|include|include_once|abstract|final|public|private|protected|static|readonly|declare|try|catch|finally|goto|var|const|global|break|continue|exit|die|unset)\b/i

function wrapLastExpression(userCode) {
  let code = userCode.replace(/^\s*<\?(php|=)?\s*/i, '').replace(/\?>\s*$/i, '').trimEnd()
  if (!code) return ''

  const lastSemi = code.lastIndexOf(';')
  let prefix, lastExpr, suffix

  if (lastSemi === -1) {
    prefix = ''
    lastExpr = code.trim()
    suffix = ''
  } else {
    const beforeLastSemi = code.slice(0, lastSemi)
    const prevSemi = beforeLastSemi.lastIndexOf(';')
    prefix = code.slice(0, prevSemi + 1)
    lastExpr = code.slice(prevSemi + 1, lastSemi).trim()
    suffix = code.slice(lastSemi + 1)
  }

  const isExpression =
    lastExpr.length > 0 &&
    !RESERVED_STARTS.test(lastExpr) &&
    !lastExpr.startsWith('}') &&
    !lastExpr.startsWith('{')

  if (!isExpression) {
    // Forgiving terminator: if the user's last statement is missing a `;`
    // (e.g. they typed `echo "hi"` without trailing semicolon), append one
    // so PHP doesn't bail with a misleading "unexpected end of file" that
    // points at our prelude line numbers. Statements that already end in
    // `;`, `}`, or `:` (label/case) are left alone.
    const trimmed = code.replace(/\s+$/, '')
    const tail = trimmed.slice(-1)
    if (trimmed && tail !== ';' && tail !== '}' && tail !== ':') {
      return trimmed + ';'
    }
    return code
  }

  return `${prefix}\n__phptinker_capture(${lastExpr});\n${suffix}`
}

/* ------------------------------------------------------------------ */
/* Script assembly                                                    */
/* ------------------------------------------------------------------ */

function buildScript({ code, mode, autoloadPath, bootstrapPath }) {
  let bootstrap = ''
  if (mode === 'composer') {
    bootstrap = buildAutoloadFragment(autoloadPath)
  } else if (mode === 'laravel') {
    bootstrap = buildLaravelBootFragment(autoloadPath, bootstrapPath)
  }

  const beforeUser = `<?php\n${BASE_PRELUDE}\n${bootstrap}\n`
  const wrapped = wrapLastExpression(code)
  // userLineOffset = how many script lines precede the user's code. Used to
  // translate PHP's "Standard input code on line N" into a user-relative
  // line number when surfacing parse/runtime errors.
  const userLineOffset = (beforeUser.match(/\n/g) || []).length
  return {
    script: beforeUser + wrapped + '\n',
    userLineOffset,
  }
}

function makeStderrRewriter(userLineOffset) {
  // Replace the in-script line numbers PHP prints with line numbers
  // relative to the user's buffer. We map both common formats:
  //   "in Standard input code on line 167"   (parse / warnings / notices)
  //   "Standard input code:167"               (some error formats)
  return (chunk) => {
    if (!chunk || typeof chunk !== 'string') return chunk
    return chunk
      .replace(/ in Standard input code on line (\d+)/g, (_m, n) => {
        const line = parseInt(n, 10) - userLineOffset
        return line > 0 ? ` in your code on line ${line}` : ' in your code'
      })
      .replace(/Standard input code:(\d+)/g, (_m, n) => {
        const line = parseInt(n, 10) - userLineOffset
        return line > 0 ? `your code:${line}` : 'your code'
      })
  }
}

/* ------------------------------------------------------------------ */
/* Spawn helper                                                       */
/* ------------------------------------------------------------------ */

const BASE_PHP_ARGS = [
  '-d', 'display_errors=1',
  '-d', 'error_reporting=E_ALL',
  // -d output_buffering=0 / implicit_flush=1 are required for true
  // streaming — without them PHP buffers stdout to pipes.
  '-d', 'output_buffering=0',
  '-d', 'implicit_flush=1',
]

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function expandLocalPath(value) {
  if (!value.startsWith('~/')) return value
  return path.join(os.homedir(), value.slice(2))
}

export function normalizeSshConfig(config = {}) {
  const host = typeof config.host === 'string' ? config.host.trim() : ''
  const user = typeof config.user === 'string' ? config.user.trim() : ''
  const port = Number.parseInt(config.port, 10)
  const identityFile = typeof config.identityFile === 'string' ? config.identityFile.trim() : ''
  const phpPath = typeof config.phpPath === 'string' && config.phpPath.trim()
    ? config.phpPath.trim()
    : 'php'
  const projectPath = typeof config.projectPath === 'string' ? config.projectPath.trim() : ''
  const mode = ['raw', 'composer', 'laravel'].includes(config.mode) ? config.mode : 'raw'

  return {
    enabled: !!config.enabled,
    host,
    user,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
    identityFile,
    phpPath,
    projectPath,
    mode,
  }
}

export function buildSshArgs(config, remoteCommand) {
  const target = config.user ? `${config.user}@${config.host}` : config.host
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes',
    '-p', String(config.port),
  ]

  if (config.identityFile) {
    args.push('-i', expandLocalPath(config.identityFile))
  }

  args.push(target, remoteCommand)
  return args
}

export function validateRemotePhpPath(phpPath) {
  const value = typeof phpPath === 'string' ? phpPath.trim() : ''
  if (!value) return 'Remote PHP binary is required'
  if (value.startsWith('/')) return null
  if (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) return null
  return 'Remote PHP binary must be an absolute path or a command name without slashes'
}

export function buildRemotePhpCommand({ phpPath, cwd, args }) {
  const value = typeof phpPath === 'string' ? phpPath.trim() : ''
  const validationError = validateRemotePhpPath(value)
  if (validationError) throw new Error(validationError)

  const quotedArgs = args.map(shellQuote).join(' ')
  if (value.startsWith('/')) {
    const php = [shellQuote(value), quotedArgs].filter(Boolean).join(' ')
    return cwd ? `cd ${shellQuote(cwd)} && ${php}` : php
  }

  // Resolve a bare command before changing into the selected project. This
  // prevents a project-controlled ./php from being selected when a remote
  // PATH contains the current directory.
  const resolve = `php_bin=$(command -v ${shellQuote(value)}) || { echo 'Remote PHP binary not found' >&2; exit 127; }`
  const requireAbsolute = `case "$php_bin" in /*) ;; *) echo 'Remote PHP command did not resolve to an absolute path' >&2; exit 127 ;; esac`
  const invoke = [`"$php_bin"`, quotedArgs].filter(Boolean).join(' ')
  return [resolve, requireAbsolute, cwd ? `cd ${shellQuote(cwd)}` : null, invoke]
    .filter(Boolean)
    .join(' && ')
}

function buildRemoteContext(config) {
  const projectPath = config.projectPath || ''
  const mode = projectPath ? config.mode : 'raw'
  // The remote command `cd`s into projectPath before running php, so paths
  // baked into the script must be relative to that cwd — not prefixed with
  // projectPath again, which double-nests when projectPath is relative.
  return {
    mode,
    cwd: projectPath || undefined,
    autoloadPath: projectPath && (mode === 'composer' || mode === 'laravel')
      ? 'vendor/autoload.php'
      : undefined,
    bootstrapPath: projectPath && mode === 'laravel'
      ? 'bootstrap/app.php'
      : undefined,
  }
}

export function validateSshConfig(config) {
  if (!config.host) return 'SSH host is required'
  if (config.host.startsWith('-')) return 'SSH host cannot start with "-"'
  if (/\s/.test(config.host)) return 'SSH host cannot contain spaces'
  if (config.user && config.user.startsWith('-')) return 'SSH user cannot start with "-"'
  if (config.user && /\s/.test(config.user)) return 'SSH user cannot contain spaces'
  if (config.identityFile && config.identityFile.startsWith('-')) {
    return 'SSH identity file cannot start with "-"'
  }
  const phpPathError = validateRemotePhpPath(config.phpPath)
  if (phpPathError) return phpPathError
  return null
}

/**
 * Execute PHP code and stream output as it arrives.
 *
 * @param {string} code
 * @param {object} [options]
 * @param {string} [options.phpPath='php']
 * @param {number} [options.timeoutMs=30000]
 * @param {string} [options.cwd]                    Working directory for PHP.
 * @param {string} [options.autoloadPath]           vendor/autoload.php (required for composer/laravel modes).
 * @param {string} [options.bootstrapPath]          bootstrap/app.php (required for laravel mode).
 * @param {'raw'|'composer'|'laravel'} [options.mode='raw']
 * @param {string[]} [options.extraArgs]            Extra `-d` flags etc. appended to PHP args.
 * @param {(chunk: string) => void} [options.onStdout]
 * @param {(chunk: string) => void} [options.onStderr]
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number, durationMs:number, timedOut:boolean, mode:string}>}
 */
export async function runPhp(code, options = {}) {
  const {
    phpPath = 'php',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd,
    autoloadPath,
    bootstrapPath,
    mode = 'raw',
    extraArgs = [],
    onStdout,
    onStderr,
    maxOutputBytes = MAX_EXEC_OUTPUT_BYTES,
  } = options

  const start = performance.now()

  // Laravel apps are heavy; bump the memory limit only when we boot one.
  const modeArgs =
    mode === 'laravel' ? ['-d', 'memory_limit=512M'] : []

  const args = [...BASE_PHP_ARGS, ...modeArgs, ...extraArgs]
  const { script, userLineOffset } = buildScript({ code, mode, autoloadPath, bootstrapPath })
  const rewriteStderr = makeStderrRewriter(userLineOffset)

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(phpPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: cwd || undefined,
      })
    } catch (err) {
      resolve({
        stdout: '',
        stderr: `PHP binary not found at: ${phpPath}`,
        exitCode: -1,
        durationMs: 0,
        timedOut: false,
        mode,
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
        mode,
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
      const fixed = rewriteStderr(chunk)
      const accepted = takeUtf8Chunk(fixed, outputLimit - outputBytes)
      if (accepted) {
        outputBytes += Buffer.byteLength(accepted, 'utf8')
        stderr += accepted
        if (onStderr) onStderr(accepted)
      }
      if (!outputLimited && Buffer.byteLength(fixed, 'utf8') > Buffer.byteLength(accepted, 'utf8')) {
        outputLimited = true
        const message = `\n[execution stopped: ${outputLimit} byte output limit reached]\n`
        stderr += message
        if (onStderr) onStderr(message)
        try { child.kill('SIGKILL') } catch {}
      }
    })

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        stderr = `PHP binary not found at: ${phpPath}`
        finish(-1)
      } else {
        stderr += `\n[spawn error] ${err.message}`
        finish(-1)
      }
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
 * Execute PHP code on a remote server through the local OpenSSH client.
 *
 * Authentication is intentionally delegated to ssh itself, so key files,
 * ssh-agent, and ~/.ssh/config keep working without this app storing secrets.
 *
 * @param {string} code
 * @param {object} [options]
 * @param {object} [options.ssh]
 * @param {number} [options.timeoutMs=30000]
 * @param {string[]} [options.extraArgs]
 * @param {(chunk: string) => void} [options.onStdout]
 * @param {(chunk: string) => void} [options.onStderr]
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number, durationMs:number, timedOut:boolean, mode:string, remote:boolean}>}
 */
export async function runPhpOverSsh(code, options = {}) {
  const {
    ssh = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    extraArgs = [],
    onStdout,
    onStderr,
    maxOutputBytes = MAX_EXEC_OUTPUT_BYTES,
  } = options

  const config = normalizeSshConfig(ssh)
  const configError = validateSshConfig(config)
  if (configError) {
    return {
      stdout: '',
      stderr: configError,
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      mode: config.mode,
      remote: true,
    }
  }

  const start = performance.now()
  const remoteCtx = buildRemoteContext(config)
  const modeArgs = remoteCtx.mode === 'laravel' ? ['-d', 'memory_limit=512M'] : []
  const args = [...BASE_PHP_ARGS, ...modeArgs, ...extraArgs]
  const { script, userLineOffset } = buildScript({
    code,
    mode: remoteCtx.mode,
    autoloadPath: remoteCtx.autoloadPath,
    bootstrapPath: remoteCtx.bootstrapPath,
  })
  const rewriteStderr = makeStderrRewriter(userLineOffset)
  const remoteCommand = buildRemotePhpCommand({
    phpPath: config.phpPath,
    cwd: remoteCtx.cwd,
    args,
  })

  return new Promise((resolve) => {
    let child
    try {
      child = spawn('ssh', buildSshArgs(config, remoteCommand), {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({
        stdout: '',
        stderr: `Unable to start ssh: ${err.message}`,
        exitCode: -1,
        durationMs: 0,
        timedOut: false,
        mode: remoteCtx.mode,
        remote: true,
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
        mode: remoteCtx.mode,
        remote: true,
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
      const fixed = rewriteStderr(chunk)
      const accepted = takeUtf8Chunk(fixed, outputLimit - outputBytes)
      if (accepted) {
        outputBytes += Buffer.byteLength(accepted, 'utf8')
        stderr += accepted
        if (onStderr) onStderr(accepted)
      }
      if (!outputLimited && Buffer.byteLength(fixed, 'utf8') > Buffer.byteLength(accepted, 'utf8')) {
        outputLimited = true
        const message = `\n[execution stopped: ${outputLimit} byte output limit reached]\n`
        stderr += message
        if (onStderr) onStderr(message)
        try { child.kill('SIGKILL') } catch {}
      }
    })

    child.on('error', (err) => {
      stderr += err.code === 'ENOENT'
        ? 'OpenSSH client not found. Install ssh or add it to PATH.'
        : `\n[ssh error] ${err.message}`
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
      // child.on('error') or close will resolve.
    }
  })
}

export async function testSshConnection(ssh = {}, {spawnProcess = spawn, maxOutputBytes = 64 * 1024, timeoutMs = 15_000} = {}) {
  const config = normalizeSshConfig(ssh)
  const configError = validateSshConfig(config)
  if (configError) {
    return { ok: false, error: configError, version: null }
  }

  const remoteCtx = buildRemoteContext(config)
  const remoteCommand = buildRemotePhpCommand({
    phpPath: config.phpPath,
    cwd: remoteCtx.cwd,
    args: ['-v'],
  })

  return new Promise((resolve) => {
    let child
    try {
      child = spawnProcess('ssh', buildSshArgs(config, remoteCommand), {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ ok: false, error: `Unable to start ssh: ${err.message}`, version: null })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let outputBytes = 0

    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ ok: false, error: 'SSH connection timed out', version: null })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const capture = (chunk, isError) => {
      if (settled) return
      outputBytes += Buffer.byteLength(chunk, 'utf8')
      if (outputBytes > maxOutputBytes) {
        finish({ok: false, error: 'SSH test output exceeded its safety limit', version: null})
        try { child.kill('SIGKILL') } catch {}
        return
      }
      if (isError) stderr += chunk
      else stdout += chunk
    }
    child.stdout.on('data', chunk => capture(chunk, false))
    child.stderr.on('data', chunk => capture(chunk, true))

    child.on('error', (err) => {
      finish({
        ok: false,
        error: err.code === 'ENOENT'
          ? 'OpenSSH client not found. Install ssh or add it to PATH.'
          : err.message,
        version: null,
      })
    })

    child.on('close', (code) => {
      if (code === 0 && stdout) {
        finish({
          ok: true,
          error: null,
          version: stdout.split('\n')[0].trim(),
          mode: remoteCtx.mode,
        })
      } else {
        finish({
          ok: false,
          error: (stderr || stdout || `ssh exited with code ${code}`).trim(),
          version: null,
          mode: remoteCtx.mode,
        })
      }
    })
  })
}

/**
 * Probe the PHP binary for its version string.
 */
export async function getPhpVersion(phpPath = 'php') {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(phpPath, ['-v'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ version: null, path: phpPath, error: err.message })
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
        path: phpPath,
        error: e.code === 'ENOENT' ? `PHP binary not found at: ${phpPath}` : e.message,
      })
    })

    child.on('close', (code) => {
      if (code === 0 && out) {
        resolve({ version: out.split('\n')[0].trim(), path: phpPath })
      } else {
        resolve({
          version: null,
          path: phpPath,
          error: (err || out || `php -v exited with code ${code}`).trim(),
        })
      }
    })
  })
}

/**
 * Validate that a directory is a composer project, and detect Laravel.
 *
 * @param {string} projectPath
 * @returns {Promise<{
 *   valid: boolean,
 *   autoloadPath: string|null,
 *   bootstrapPath: string|null,
 *   isLaravel: boolean,
 *   name: string|null,
 *   laravelVersion: string|null,
 *   hasPackageJson: boolean,
 *   nodeProjectName: string|null,
 *   error: string|null,
 *   projectPath: string|null
 * }>}
 */
export async function validateProject(projectPath) {
  const result = {
    valid: false,
    autoloadPath: null,
    bootstrapPath: null,
    isLaravel: false,
    name: null,
    laravelVersion: null,
    hasPackageJson: false,
    nodeProjectName: null,
    error: null,
    projectPath: projectPath || null,
  }

  if (!projectPath) {
    result.error = 'No project path provided'
    return result
  }

  try {
    const stat = await fs.stat(projectPath)
    if (!stat.isDirectory()) {
      result.error = 'Path is not a directory'
      return result
    }
  } catch (err) {
    result.error = err.code === 'ENOENT'
      ? 'Folder not found'
      : `Cannot read folder: ${err.message}`
    return result
  }

  // Best-effort Node detection — independent of composer presence.
  try {
    await fs.access(path.join(projectPath, 'package.json'), fs.constants.R_OK)
    result.hasPackageJson = true
    try {
      const raw = await readBoundedFile(path.join(projectPath, 'package.json'))
      const parsed = JSON.parse(raw)
      if (typeof parsed?.name === 'string') result.nodeProjectName = parsed.name
    } catch {
      // package.json present but unparseable — still mark hasPackageJson true.
    }
  } catch {
    // No package.json — not a Node project. Fine.
  }

  const autoloadPath = path.join(projectPath, 'vendor', 'autoload.php')
  try {
    await fs.access(autoloadPath, fs.constants.R_OK)
  } catch {
    // No composer autoload. If this is a Node-only project, that's still
    // a valid project for JS mode — surface name/path and return early.
    if (result.hasPackageJson) {
      result.name = path.basename(projectPath)
      result.valid = true
      return result
    }
    result.error = 'vendor/autoload.php not found. Run composer install first.'
    return result
  }
  result.autoloadPath = autoloadPath

  // Best-effort: pull Laravel detection from composer.json. Display name
  // is always the folder basename — composer's package name (e.g.
  // "laravel/laravel") doesn't match what users selected on disk.
  try {
    const raw = await readBoundedFile(path.join(projectPath, 'composer.json'))
    const parsed = JSON.parse(raw)
    const framework = parsed.require?.['laravel/framework'] ?? parsed['require-dev']?.['laravel/framework']
    if (typeof framework === 'string') {
      result.laravelVersion = framework
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      result.error = `Cannot read Composer metadata: ${error.message}`
      return result
    }
    // ignore — composer.json is optional for our purposes.
  }

  const bootstrapPath = path.join(projectPath, 'bootstrap', 'app.php')
  try {
    await fs.access(bootstrapPath, fs.constants.R_OK)
    // Both bootstrap/app.php AND laravel/framework in composer.json → confidently Laravel.
    if (result.laravelVersion) {
      result.isLaravel = true
      result.bootstrapPath = bootstrapPath
    } else {
      // bootstrap/app.php exists but no laravel/framework — could be Lumen or
      // a custom app. Don't claim Laravel, but record the path in case.
      result.bootstrapPath = bootstrapPath
    }
  } catch {
    // No bootstrap file — composer-only project.
  }

  result.name = path.basename(projectPath)

  result.valid = true
  return result
}
