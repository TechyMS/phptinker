import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenizerArguments } from '../electron/scannerRuntime.js'

test('built-in tokenizer needs no shared extension', () => {
  assert.deepEqual(tokenizerArguments({ tokenizer: true }), [])
})

test('modular tokenizer loads only from the runtime absolute extension directory', () => {
  assert.deepEqual(tokenizerArguments({ tokenizer: false, directory: '/usr/lib/php/20240924', suffix: 'so' }, 'linux'),
    ['-d', 'extension=/usr/lib/php/20240924/tokenizer.so'])
  assert.deepEqual(tokenizerArguments({ tokenizer: false, directory: 'D:\\PHP\\ext', suffix: 'dll' }, 'win32'),
    ['-d', 'extension=D:\\PHP\\ext\\php_tokenizer.dll'])
})

test('relative or malformed extension metadata cannot load project libraries', () => {
  for (const directory of ['.', 'ext', '', null]) {
    assert.throws(() => tokenizerArguments({ tokenizer: false, directory, suffix: 'so' }, 'linux'), /tokenizer/)
  }
  assert.throws(() => tokenizerArguments({ tokenizer: false, directory: '/usr/lib/php', suffix: '../evil' }, 'linux'), /tokenizer/)
})
