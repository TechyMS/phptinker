import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readBoundedFile } from './boundedFile.js'
import { secureDirectory, secureFile } from './privateStorage.js'
import { probeTokenizer, TOKENIZER_PROBE_ARGS } from './scannerRuntime.js'
import {
  buildRemotePhpCommand,
  buildSshArgs,
  normalizeSshConfig,
  validateRemotePhpPath,
} from './executor.js'

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const SCAN_TIMEOUT_MS = 60_000
const MAX_SCAN_OUTPUT_BYTES = 64 * 1024 * 1024
const CACHE_SCHEMA = 2

/* ------------------------------------------------------------------ */
/* Safe Composer metadata scanner.                                    */
/*                                                                    */
/* Composer's generated autoload_*.php files are executable PHP.      */
/* Requiring them while a project is opened would execute untrusted   */
/* project code before the user presses Run. This bundled scanner     */
/* reads JSON metadata and tokenizes PHP source without requiring it. */
/* -n prevents project/user PHP configuration from prepending code.   */
/* ------------------------------------------------------------------ */

export const SAFE_SCAN_PHP = `<?php
if (!function_exists('token_get_all')) {
    fwrite(STDERR, "PHP tokenizer extension is required for class indexing; install or enable tokenizer in the selected PHP runtime.\\n");
    exit(1);
}
$root = realpath(getcwd()) ?: getcwd();
$vendorRoot = $root . DIRECTORY_SEPARATOR . 'vendor';
$composerDir = $vendorRoot . DIRECTORY_SEPARATOR . 'composer';
$maxFiles = 200000;
$visitedFiles = 0;
$blockedRoots = [];
$skippedFiles = 0;
$readBytes = 0;
$maxReadBytes = 64 * 1024 * 1024;

function pt_allowed_path($file) {
    global $root, $blockedRoots;
    clearstatcache(true);
    $canonical = realpath($file);
    if ($canonical === false) return null;
    $base = rtrim(str_replace('\\\\', '/', $root), '/');
    $value = str_replace('\\\\', '/', $canonical);
    if (DIRECTORY_SEPARATOR === '\\\\') { $base = strtolower($base); $value = strtolower($value); }
    if ($value === $base || strpos($value, $base . '/') === 0) return $canonical;
    if (count($blockedRoots) < 100) $blockedRoots[$canonical] = true;
    return null;
}

function pt_read_limited($file, $limit) {
    global $readBytes, $maxReadBytes, $skippedFiles;
    $canonical = pt_allowed_path($file);
    if (!$canonical || !is_file($canonical)) return null;
    $size = @filesize($canonical);
    if ($size === false || $size > $limit || $readBytes + $size > $maxReadBytes) { $skippedFiles++; return null; }
    $handle = @fopen($canonical, 'rb');
    if (!$handle) return null;
    try {
        $stat = fstat($handle);
        if (!$stat || ($stat['mode'] & 0170000) !== 0100000) return null;
        // Revalidate the opened object before reading, not only its original path.
        clearstatcache(true);
        $openedPath = pt_allowed_path($canonical);
        $current = $openedPath ? @stat($openedPath) : false;
        if (!$current || $current['dev'] !== $stat['dev'] || $current['ino'] !== $stat['ino']) {
            $skippedFiles++;
            return null;
        }
        $budget = min($limit, $maxReadBytes - $readBytes);
        $raw = stream_get_contents($handle, $budget + 1);
        if ($raw === false) return null;
        if (strlen($raw) > $budget) { $skippedFiles++; return null; }
        $readBytes += strlen($raw);
        return $raw;
    } finally { fclose($handle); }
}

function pt_read_json($file) {
    $raw = pt_read_limited($file, 8 * 1024 * 1024);
    if ($raw === null) return null;
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

function pt_is_absolute($value) {
    return is_string($value) && (
        substr($value, 0, 1) === '/' ||
        substr($value, 0, 2) === '\\\\' ||
        preg_match('~^[A-Za-z]:[\\\\\\/]~', $value) === 1
    );
}

function pt_resolve($base, $value) {
    if (!is_string($value) || trim($value) === '') return null;
    $candidate = pt_is_absolute($value)
        ? $value
        : $base . DIRECTORY_SEPARATOR . $value;
    return pt_allowed_path($candidate);
}

function pt_autoload_sections($package) {
    $sections = [];
    if (isset($package['autoload']) && is_array($package['autoload'])) {
        $sections[] = $package['autoload'];
    }
    if (isset($package['autoload-dev']) && is_array($package['autoload-dev'])) {
        $sections[] = $package['autoload-dev'];
    }
    return $sections;
}

$psr4 = [];
$classmapPaths = [];
$excludePatterns = [];

function pt_add_autoload($autoload, $base, &$psr4, &$classmapPaths, &$excludePatterns) {
    if (isset($autoload['psr-4']) && is_array($autoload['psr-4'])) {
        foreach ($autoload['psr-4'] as $prefix => $dirs) {
            $dirs = is_array($dirs) ? $dirs : [$dirs];
            foreach ($dirs as $dir) {
                $resolved = pt_resolve($base, $dir === '' ? '.' : $dir);
                if ($resolved && is_dir($resolved)) {
                    if (!isset($psr4[(string)$prefix])) $psr4[(string)$prefix] = [];
                    if (!in_array($resolved, $psr4[(string)$prefix], true)) {
                        $psr4[(string)$prefix][] = $resolved;
                    }
                }
            }
        }
    }

    if (isset($autoload['classmap'])) {
        $paths = is_array($autoload['classmap']) ? $autoload['classmap'] : [$autoload['classmap']];
        foreach ($paths as $entry) {
            $resolved = pt_resolve($base, $entry);
            if ($resolved && !in_array($resolved, $classmapPaths, true)) {
                $classmapPaths[] = $resolved;
            }
        }
    }

    if (isset($autoload['exclude-from-classmap'])) {
        $patterns = is_array($autoload['exclude-from-classmap'])
            ? $autoload['exclude-from-classmap']
            : [$autoload['exclude-from-classmap']];
        foreach ($patterns as $pattern) {
            if (!is_string($pattern) || trim($pattern) === '') continue;
            $normalizedBase = rtrim(str_replace('\\\\', '/', $base), '/');
            $normalizedPattern = ltrim(str_replace('\\\\', '/', trim($pattern)), '/');
            $absolutePattern = $normalizedBase . '/' . $normalizedPattern;
            if (!in_array($absolutePattern, $excludePatterns, true)) {
                $excludePatterns[] = $absolutePattern;
            }
        }
    }
}

$rootComposer = pt_read_json($root . DIRECTORY_SEPARATOR . 'composer.json');
if ($rootComposer) {
    foreach (pt_autoload_sections($rootComposer) as $section) {
        pt_add_autoload($section, $root, $psr4, $classmapPaths, $excludePatterns);
    }
}

$installed = pt_read_json($composerDir . DIRECTORY_SEPARATOR . 'installed.json');
if ($installed) {
    $packages = isset($installed['packages']) && is_array($installed['packages'])
        ? $installed['packages']
        : $installed;
    foreach ($packages as $package) {
        if (!is_array($package)) continue;
        $installPath = null;
        if (isset($package['install_path'])) {
            $installPath = pt_resolve($composerDir, $package['install_path']);
        }
        if (!$installPath && isset($package['name']) && is_string($package['name'])) {
            $installPath = pt_resolve($vendorRoot, $package['name']);
        }
        if (!$installPath || !is_dir($installPath)) continue;
        foreach (pt_autoload_sections($package) as $section) {
            pt_add_autoload($section, $installPath, $psr4, $classmapPaths, $excludePatterns);
        }
    }
}

$skipDirs = ['node_modules','.git','.idea','.vscode'];
$skipPathPatterns = ['/database/migrations','/database/seeders','/database/factories','/bootstrap/cache'];

function pt_should_skip($path, $name, $skipDirs, $skipPathPatterns) {
    if ($name !== '' && substr($name, 0, 1) === '.') return true;
    if (in_array($name, $skipDirs, true)) return true;
    $normalized = str_replace('\\\\', '/', $path);
    foreach ($skipPathPatterns as $pattern) {
        if (strpos($normalized, $pattern . '/') !== false || substr($normalized, -strlen($pattern)) === $pattern) {
            return true;
        }
    }
    return false;
}

function pt_source_files($path, $skipDirs, $skipPathPatterns, &$visitedFiles, $maxFiles, $extensions) {
    global $skippedFiles;
    $path = pt_allowed_path($path);
    if (!$path) return [];
    if (is_file($path)) {
        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (filesize($path) > 2 * 1024 * 1024) { $skippedFiles++; return []; }
        return in_array($extension, $extensions, true) ? [$path] : [];
    }
    if (!is_dir($path)) return [];

    $files = [];
    $queue = [$path];
    $seenDirs = [];
    $queueIndex = 0;
    while ($queueIndex < count($queue) && $visitedFiles < $maxFiles && count($seenDirs) < $maxFiles) {
        $dir = $queue[$queueIndex++];
        $realDir = pt_allowed_path($dir);
        if (!$realDir || isset($seenDirs[$realDir])) continue;
        $seenDirs[$realDir] = true;
        $entries = @scandir($dir);
        if (!is_array($entries)) continue;
        foreach ($entries as $name) {
            if ($name === '.' || $name === '..') continue;
            $absolute = $dir . DIRECTORY_SEPARATOR . $name;
            $canonical = pt_allowed_path($absolute);
            if (!$canonical) continue;
            if (is_dir($absolute)) {
                if (!pt_should_skip($absolute, $name, $skipDirs, $skipPathPatterns)) {
                    $queue[] = $absolute;
                }
            } elseif (is_file($absolute) && in_array(strtolower(pathinfo($name, PATHINFO_EXTENSION)), $extensions, true)) {
                if (filesize($absolute) > 2 * 1024 * 1024) { $skippedFiles++; continue; }
                $files[] = $absolute;
                $visitedFiles++;
                if ($visitedFiles >= $maxFiles) break 2;
            }
        }
    }
    return $files;
}

function pt_is_excluded($file, $patterns) {
    $normalized = str_replace('\\\\', '/', $file);
    foreach ($patterns as $pattern) {
        $quoted = preg_quote($pattern, '~');
        $quoted = str_replace('\\*\\*', '.*', $quoted);
        $quoted = str_replace('\\*', '[^/]*', $quoted);
        if (substr($pattern, -1) === '/') $quoted .= '.*';
        if (preg_match('~^' . $quoted . '$~', $normalized) === 1) return true;
        if (substr($pattern, -1) === '/' && preg_match('~^' . $quoted . '~', $normalized) === 1) return true;
    }
    return false;
}

function pt_decode_string_token($literal) {
    if (!is_string($literal) || strlen($literal) < 2) return null;
    $quote = $literal[0];
    $inner = substr($literal, 1, -1);
    if ($quote === "'") return strtr($inner, ["\\\\'" => "'", "\\\\\\\\" => "\\\\"]);
    if ($quote === '"') return stripcslashes($inner);
    return null;
}

function pt_generated_class_names($file) {
    $source = pt_read_limited($file, 8 * 1024 * 1024);
    if ($source === null) return [];
    $tokens = token_get_all($source);
    $classes = [];
    for ($i = 0, $count = count($tokens); $i < $count; $i++) {
        $token = $tokens[$i];
        if (!is_array($token) || $token[0] !== T_CONSTANT_ENCAPSED_STRING) continue;
        for ($j = $i + 1; $j < $count; $j++) {
            $next = $tokens[$j];
            if (is_array($next) && in_array($next[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
            if (is_array($next) && $next[0] === T_DOUBLE_ARROW) {
                $name = pt_decode_string_token($token[1]);
                if (is_string($name) && preg_match('/^[A-Za-z_][A-Za-z0-9_\\\\\\\\]*$/', $name) === 1) {
                    $classes[] = $name;
                }
            }
            break;
        }
    }
    return $classes;
}

function pt_source($file, $vendorRoot) {
    $vendor = rtrim(str_replace('\\\\', '/', $vendorRoot), '/') . '/';
    $normalized = str_replace('\\\\', '/', $file);
    return strpos($normalized, $vendor) === 0 ? 'vendor' : 'app';
}

function pt_symbols($file) {
    $source = pt_read_limited($file, 2 * 1024 * 1024);
    if ($source === null) return [];
    $tokens = token_get_all($source);
    $symbols = [];
    $namespace = '';
    $previousSignificant = null;
    $nameTokens = [T_STRING, T_NS_SEPARATOR];
    if (defined('T_NAME_QUALIFIED')) $nameTokens[] = constant('T_NAME_QUALIFIED');
    if (defined('T_NAME_FULLY_QUALIFIED')) $nameTokens[] = constant('T_NAME_FULLY_QUALIFIED');
    $declarationTokens = [T_CLASS, T_INTERFACE, T_TRAIT];
    if (defined('T_ENUM')) $declarationTokens[] = constant('T_ENUM');

    for ($i = 0, $count = count($tokens); $i < $count; $i++) {
        $token = $tokens[$i];
        if (!is_array($token)) {
            if (trim($token) !== '') $previousSignificant = $token;
            continue;
        }

        $id = $token[0];
        if ($id === T_WHITESPACE || $id === T_COMMENT || $id === T_DOC_COMMENT) continue;

        if ($id === T_NAMESPACE) {
            $namespace = '';
            for ($j = $i + 1; $j < $count; $j++) {
                $next = $tokens[$j];
                if (!is_array($next)) {
                    if ($next === ';' || $next === '{') { $i = $j; break; }
                    continue;
                }
                if (in_array($next[0], $nameTokens, true)) $namespace .= $next[1];
            }
            $namespace = trim($namespace, '\\\\');
            $previousSignificant = T_NAMESPACE;
            continue;
        }

        if (in_array($id, $declarationTokens, true)) {
            if ($previousSignificant === T_NEW || $previousSignificant === T_DOUBLE_COLON) {
                $previousSignificant = $id;
                continue;
            }
            for ($j = $i + 1; $j < $count; $j++) {
                $next = $tokens[$j];
                if (is_array($next) && $next[0] === T_STRING) {
                    $symbols[] = $namespace !== '' ? $namespace . '\\\\' . $next[1] : $next[1];
                    break;
                }
                if (!is_array($next) && trim($next) !== '') break;
            }
        }
        $previousSignificant = $id;
    }
    return $symbols;
}

$classes = [];

foreach ($classmapPaths as $mappedPath) {
    foreach (pt_source_files($mappedPath, $skipDirs, $skipPathPatterns, $visitedFiles, $maxFiles, ['php', 'inc']) as $file) {
        if (pt_is_excluded($file, $excludePatterns)) continue;
        foreach (pt_symbols($file) as $fqcn) {
            if ($fqcn === '' || strpos($fqcn, 'Composer\\\\') === 0) continue;
            $index = strrpos($fqcn, '\\\\');
            $namespace = $index === false ? '' : substr($fqcn, 0, $index);
            $short = $index === false ? $fqcn : substr($fqcn, $index + 1);
            $classes[$fqcn] = [
                'fqcn' => $fqcn,
                'shortName' => $short,
                'namespace' => $namespace,
                'source' => pt_source($file, $vendorRoot),
                'file' => $file,
            ];
        }
    }
}

foreach ($psr4 as $prefix => $dirs) {
    foreach ($dirs as $dir) {
        $base = rtrim($dir, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
        foreach (pt_source_files($dir, $skipDirs, $skipPathPatterns, $visitedFiles, $maxFiles, ['php']) as $file) {
            if (pt_is_excluded($file, $excludePatterns)) continue;
            if (strpos($file, $base) !== 0) continue;
            $relative = substr($file, strlen($base));
            if (substr($relative, -4) !== '.php') continue;
            $withoutExtension = substr($relative, 0, -4);
            $segments = preg_split('~[\\\\\\/]+~', $withoutExtension, -1, PREG_SPLIT_NO_EMPTY);
            if (!$segments) continue;
            $last = $segments[count($segments) - 1];
            if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $last) !== 1) continue;
            $tail = implode('\\\\', $segments);
            $namespace = rtrim((string)$prefix, '\\\\');
            $fqcn = $namespace !== '' ? $namespace . '\\\\' . $tail : $tail;
            if (preg_match('/^[A-Za-z_][A-Za-z0-9_\\\\\\\\]*$/', $fqcn) !== 1) continue;
            $index = strrpos($fqcn, '\\\\');
            $namespaceOnly = $index === false ? '' : substr($fqcn, 0, $index);
            $short = $index === false ? $fqcn : substr($fqcn, $index + 1);
            $classes[$fqcn] = [
                'fqcn' => $fqcn,
                'shortName' => $short,
                'namespace' => $namespaceOnly,
                'source' => pt_source($file, $vendorRoot),
                'file' => $file,
            ];
        }
    }
}

// Composer's generated classmap is authoritative for explicit classmap
// entries and optimized PSR discovery. Parse only literal array keys; never
// require or evaluate this project-controlled PHP file.
foreach (pt_generated_class_names($composerDir . DIRECTORY_SEPARATOR . 'autoload_classmap.php') as $fqcn) {
    if ($fqcn === '' || strpos($fqcn, 'Composer\\\\') === 0 || isset($classes[$fqcn])) continue;
    $index = strrpos($fqcn, '\\\\');
    $namespace = $index === false ? '' : substr($fqcn, 0, $index);
    $short = $index === false ? $fqcn : substr($fqcn, $index + 1);
    $classes[$fqcn] = [
        'fqcn' => $fqcn,
        'shortName' => $short,
        'namespace' => $namespace,
        'source' => 'classmap',
        'file' => '',
    ];
}

$values = array_values($classes);
echo json_encode([
    'classes' => $values,
    'count' => count($values),
    'truncated' => $visitedFiles >= $maxFiles || $skippedFiles > 0,
    'blockedRoots' => array_keys($blockedRoots),
]);
`;

async function runSafePhpScanner(phpPath, cwd, { timeoutMs = SCAN_TIMEOUT_MS } = {}) {
  if (typeof phpPath !== 'string' || !path.isAbsolute(phpPath)) {
    return Promise.reject(new Error('An absolute PHP executable path is required for class indexing'))
  }
  const tokenizerArgs = await probeTokenizer(phpPath)
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(phpPath, [
        '-n',
        ...tokenizerArgs,
        '-d', 'display_errors=stderr',
        '-d', 'log_errors=0',
        '-d', 'memory_limit=256M',
        '-d', 'auto_prepend_file=',
        '-d', 'auto_append_file=',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
      })
    } catch (err) {
      reject(err)
      return
    }

    let out = ''
    let err = ''
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish(() => reject(new Error('Class scan timed out')))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (settled) return
      if (Buffer.byteLength(out, 'utf8') + Buffer.byteLength(chunk, 'utf8') > MAX_SCAN_OUTPUT_BYTES) {
        finish(() => reject(new Error('Class scan produced too much output')))
        try { child.kill('SIGKILL') } catch {}
        return
      }
      out += chunk
      if (Buffer.byteLength(out, 'utf8') > MAX_SCAN_OUTPUT_BYTES) {
        try { child.kill('SIGKILL') } catch {}
        finish(() => reject(new Error('Class scan produced too much output')))
      }
    })
    child.stderr.on('data', (chunk) => {
      if (settled) return
      if (Buffer.byteLength(err, 'utf8') + Buffer.byteLength(chunk, 'utf8') > 1024 * 1024) {
        finish(() => reject(new Error('Class scan produced too much error output')))
        try { child.kill('SIGKILL') } catch {}
        return
      }
      err += chunk
      if (Buffer.byteLength(err, 'utf8') > 1024 * 1024) {
        try { child.kill('SIGKILL') } catch {}
        finish(() => reject(new Error('Class scan produced too much error output')))
      }
    })
    child.on('error', (error) => finish(() => reject(error)))
    child.stdin.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(err.trim() || `php exited with ${code}`))
          return
        }
        try {
          resolve(JSON.parse(out))
        } catch (error) {
          reject(new Error(`Failed to parse PHP output as JSON: ${error.message}`))
        }
      })
    })
    try {
      child.stdin.write(SAFE_SCAN_PHP)
      child.stdin.end()
    } catch {
      // error/close handlers settle the promise
    }
  })
}

/* ------------------------------------------------------------------ */
/* Disk cache                                                         */
/* ------------------------------------------------------------------ */

function cacheKey(projectPath) {
  return crypto.createHash('sha1').update(projectPath).digest('hex').slice(0, 16)
}

function cacheFilePath(userDataDir, projectPath) {
  return path.join(userDataDir, 'class-cache', `${cacheKey(projectPath)}.json`)
}

async function readCacheFile(userDataDir, projectPath) {
  try {
    const file = cacheFilePath(userDataDir, projectPath)
    secureFile(file)
    const raw = await readBoundedFile(file, {maxBytes: MAX_SCAN_OUTPUT_BYTES})
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function writeCacheFile(userDataDir, projectPath, data) {
  const file = cacheFilePath(userDataDir, projectPath)
  secureDirectory(path.dirname(file))
  secureFile(file)
  await fs.writeFile(file, JSON.stringify({...data, cacheSchema: CACHE_SCHEMA}), {encoding: 'utf8', mode: 0o600})
  secureFile(file)
}

async function getInstalledMtime(projectPath) {
  try {
    const s = await fs.stat(path.join(projectPath, 'vendor', 'composer', 'installed.json'))
    return s.mtimeMs
  } catch {
    return 0
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Scan a project for autoloadable classes by reading composer's PSR-4 + classmap files.
 *
 * @param {string} projectPath
 * @param {object} [opts]
 * @param {string} opts.phpPath validated absolute PHP executable path
 * @param {(progress: {phase:'reading'|'walking'|'done', count:number}) => void} [opts.onProgress]
 * @returns {Promise<{classes: Array, count: number, scannedAt: number, projectPath: string, installedMtime: number}>}
 */
export async function scanClasses(projectPath, opts = {}) {
  const { phpPath, onProgress } = opts
  const emit = (phase, count = 0) => onProgress?.({ phase, count })

  emit('reading', 0)
  emit('walking', 0)
  const parsed = await runSafePhpScanner(phpPath, projectPath)
  const classes = Array.isArray(parsed?.classes) ? parsed.classes : []
  onProgress?.({phase: 'done', count: classes.length, blockedRoots: parsed?.blockedRoots || [], truncated: !!parsed?.truncated})

  return {
    classes,
    count: classes.length,
    scannedAt: Date.now(),
    projectPath,
    installedMtime: await getInstalledMtime(projectPath),
    truncated: !!parsed?.truncated,
    blockedRoots: Array.isArray(parsed?.blockedRoots) ? parsed.blockedRoots : [],
    cacheSchema: CACHE_SCHEMA,
  }
}

/**
 * Load a fresh-enough cache from disk if available. Considers cache stale if:
 * - older than CACHE_TTL_MS, OR
 * - vendor/composer/installed.json is newer than the cache (composer ran since).
 */
export async function loadCachedScan(userDataDir, projectPath) {
  const data = await readCacheFile(userDataDir, projectPath)
  if (!data || data.cacheSchema !== CACHE_SCHEMA) return null
  if (Date.now() - data.scannedAt > CACHE_TTL_MS) return null

  const currentMtime = await getInstalledMtime(projectPath)
  if (currentMtime > (data.installedMtime || 0)) return null

  return data
}

export async function saveScanToDisk(userDataDir, projectPath, scan) {
  await writeCacheFile(userDataDir, projectPath, scan)
}

/* ------------------------------------------------------------------ */
/* Remote (SSH) class scan                                            */
/*                                                                    */
/* Single-round-trip: send the same non-executing metadata scanner    */
/* over SSH. It reads JSON and tokenizes PHP; it never requires files.*/
/* ------------------------------------------------------------------ */

const REMOTE_SCAN_PHP = SAFE_SCAN_PHP

export function remoteCacheKey(connection = {}) {
  const identity = [
    connection.id || 'unknown',
    connection.host || '',
    connection.user || '',
    connection.port || 22,
    connection.identityFile || '',
    connection.phpPath || 'php',
    connection.projectPath || '',
  ].join('\0')
  return `ssh:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
}

/**
 * Scan classes on a remote host over SSH. Returns the same shape as
 * scanClasses() (minus installedMtime — disk freshness on remote isn't
 * tracked here; the cache TTL still applies for staleness).
 *
 * @param {object} connection  full SSH connection (host, user, port, identityFile, phpPath, projectPath, mode)
 * @param {object} [opts]
 * @param {(progress) => void} [opts.onProgress]
 * @param {number} [opts.timeoutMs=60000]
 */
export async function scanRemoteClasses(connection, opts = {}) {
  const { onProgress, timeoutMs = 60_000 } = opts
  const cfg = normalizeSshConfig({ ...connection, enabled: true })

  if (!cfg.host) throw new Error('SSH host is required')
  if (!cfg.projectPath) throw new Error('Remote project path is required')
  const phpPathError = validateRemotePhpPath(cfg.phpPath)
  if (phpPathError) throw new Error(phpPathError)

  const emit = (phase, count = 0) => onProgress?.({ phase, count })
  emit('reading', 0)

  const probeCommand = buildRemotePhpCommand({ phpPath: cfg.phpPath, args: TOKENIZER_PROBE_ARGS })
  const tokenizerArgs = await probeTokenizer('ssh', buildSshArgs(cfg, probeCommand), 'linux')
  const phpArgs = [
    '-n',
    ...tokenizerArgs,
    '-d', 'display_errors=stderr',
    '-d', 'error_reporting=0',
    '-d', 'log_errors=0',
    '-d', 'memory_limit=256M',
    '-d', 'auto_prepend_file=',
    '-d', 'auto_append_file=',
  ]
  const remoteCommand = buildRemotePhpCommand({
    phpPath: cfg.phpPath,
    cwd: cfg.projectPath,
    args: phpArgs,
  })
  const args = buildSshArgs(cfg, remoteCommand)

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      try { child.kill('SIGKILL') } catch {}
      settled = true
      reject(new Error('Remote class scan timed out'))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (settled) return
      stdout += chunk
      if (Buffer.byteLength(stdout, 'utf8') > MAX_SCAN_OUTPUT_BYTES && !settled) {
        try { child.kill('SIGKILL') } catch {}
        settled = true
        clearTimeout(timer)
        reject(new Error('Remote class scan produced too much output'))
      }
    })
    child.stderr.on('data', (chunk) => {
      if (settled) return
      stderr += chunk
      if (Buffer.byteLength(stderr, 'utf8') > 1024 * 1024 && !settled) {
        try { child.kill('SIGKILL') } catch {}
        settled = true
        clearTimeout(timer)
        reject(new Error('Remote class scan produced too much error output'))
      }
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.stdin.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ssh exited with ${code}`))
        return
      }
      const trimmed = stdout.trim()
      if (!trimmed) {
        const detail = stderr.trim() || 'remote PHP produced no output'
        reject(new Error(`Remote scan returned nothing — ${detail}`))
        return
      }
      // Some hosts inject a banner / motd / shell rc output before our JSON.
      // Find the first '{' and parse from there.
      const start = trimmed.indexOf('{')
      const candidate = start >= 0 ? trimmed.slice(start) : trimmed
      try {
        const parsed = JSON.parse(candidate)
        onProgress?.({phase: 'done', count: parsed.count || 0, blockedRoots: parsed.blockedRoots || [], truncated: !!parsed.truncated})
        resolve({
          classes: parsed.classes || [],
          count: parsed.count || 0,
          scannedAt: Date.now(),
          projectPath: cfg.projectPath,
          remote: true,
          installedMtime: 0,
          truncated: !!parsed.truncated,
          blockedRoots: Array.isArray(parsed.blockedRoots) ? parsed.blockedRoots : [],
          cacheSchema: CACHE_SCHEMA,
        })
      } catch (e) {
        const preview = candidate.slice(0, 200).replace(/\s+/g, ' ')
        const stderrPreview = stderr.trim().slice(0, 200)
        reject(new Error(
          `Failed to parse remote scan output: ${e.message}` +
          (preview ? ` — stdout starts: ${preview}` : '') +
          (stderrPreview ? ` — stderr: ${stderrPreview}` : '')
        ))
      }
    })

    try {
      child.stdin.write(REMOTE_SCAN_PHP)
      child.stdin.end()
    } catch (err) {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    }

  })
}

/* ------------------------------------------------------------------ */
/* In-memory class cache, keyed by project path with LRU eviction.    */
/*                                                                    */
/* Why per-project rather than per-tab: two tabs pointed at the same  */
/* project should share a single cache. The cap (5) bounds RAM use    */
/* across many open projects; the disk cache still holds everything.  */
/* ------------------------------------------------------------------ */

const MEM_CACHE_LIMIT = 5
const memCache = new Map() // projectPath -> scan
const lruAccess = new Map() // projectPath -> last-access timestamp (ms)

function bumpLru(projectPath) {
  lruAccess.set(projectPath, Date.now())
}

function evictIfNeeded() {
  while (memCache.size > MEM_CACHE_LIMIT) {
    let oldestPath = null
    let oldestTs = Infinity
    for (const [path, ts] of lruAccess.entries()) {
      if (ts < oldestTs) {
        oldestTs = ts
        oldestPath = path
      }
    }
    if (!oldestPath) break
    memCache.delete(oldestPath)
    lruAccess.delete(oldestPath)
  }
}

export function getCachedScan(projectPath, { maxAgeMs = null } = {}) {
  if (!projectPath) return null
  const scan = memCache.get(projectPath)
  if (scan && Number.isFinite(maxAgeMs) && maxAgeMs >= 0) {
    const scannedAt = Number(scan.scannedAt) || 0
    if (Date.now() - scannedAt > maxAgeMs) {
      clearCachedScan(projectPath)
      return null
    }
  }
  if (scan) bumpLru(projectPath)
  return scan || null
}

export function setCachedScan(projectPath, scan) {
  if (!projectPath || !scan) return
  memCache.set(projectPath, scan)
  bumpLru(projectPath)
  evictIfNeeded()
}

export function clearCachedScan(projectPath) {
  if (!projectPath) return
  memCache.delete(projectPath)
  lruAccess.delete(projectPath)
}

export function listCachedProjects() {
  return Array.from(memCache.keys())
}
