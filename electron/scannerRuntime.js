import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'

const execute = promisify(execFile)
export const TOKENIZER_PROBE = 'echo json_encode(["tokenizer" => function_exists("token_get_all"), "directory" => ini_get("extension_dir"), "suffix" => PHP_SHLIB_SUFFIX]);'
export const TOKENIZER_PROBE_ARGS = ['-n', '-r', TOKENIZER_PROBE]

// Probe outside the project, without php.ini. Never load a project-selected library.
export async function probeTokenizer(command, args = TOKENIZER_PROBE_ARGS, platform = process.platform) {
  const { stdout } = await execute(command, args, {
    cwd: os.tmpdir(), timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true,
  }).catch(error => { throw new Error(`PHP scanner runtime probe exited with an error: ${error.message}`) })
  return tokenizerArguments(JSON.parse(stdout), platform)
}

export function tokenizerArguments(runtime, platform = process.platform) {
  if (runtime?.tokenizer === true) return []
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (runtime?.tokenizer !== false || typeof runtime.directory !== 'string' ||
      !paths.isAbsolute(runtime.directory) || /[\0\r\n]/.test(runtime.directory) ||
      !['so', 'dll'].includes(runtime.suffix)) {
    throw new Error('PHP tokenizer is unavailable and its extension directory is invalid; install PHP with tokenizer support')
  }
  const module = platform === 'win32' ? 'php_tokenizer.dll' : `tokenizer.${runtime.suffix}`
  return ['-d', `extension=${paths.join(runtime.directory, module)}`]
}
