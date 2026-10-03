import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { validateProject, testSshConnection, buildSshArgs, runPhp } from '../electron/executor.js'
import { registerPhpSnippetLanguage } from '../src/editor/phpSnippetLanguage.js'
import { scanClasses, saveScanToDisk, loadCachedScan } from '../electron/classScanner.js'
import { detectPhpBinary } from '../electron/phpRuntime.js'
import { readBoundedFile } from '../electron/boundedFile.js'
import { execFileSync } from 'node:child_process'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phptinker-boundary-'))
  t.after(() => fs.rm(root, {recursive: true, force: true}))
  return root
}

test('release packaging includes the project license and dependency notices', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'))
  assert.ok(pkg.build.files.includes('LICENSE'))
  assert.ok(pkg.build.files.includes('THIRD_PARTY_NOTICES.txt'))
  assert.equal(pkg.scripts.prebuild,'node scripts/generate-notices.mjs')
  assert.equal(pkg.scripts.predist,'node scripts/generate-notices.mjs')
})

test('oversized project metadata is not parsed by project validation', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({name:'oversized',pad:'x'.repeat(2*1024*1024)}))
  const node = await validateProject(root)
  assert.equal(node.hasPackageJson, true)
  assert.equal(node.nodeProjectName, null)
  await fs.mkdir(path.join(root, 'vendor'))
  await fs.writeFile(path.join(root, 'vendor/autoload.php'), '<?php')
  await fs.writeFile(path.join(root, 'composer.json'), JSON.stringify({require:{'laravel/framework':'^12'},pad:'x'.repeat(2*1024*1024)}))
  const composer = await validateProject(root)
  assert.equal(composer.valid, false)
  assert.match(composer.error, /metadata|size|limit/i)
})

test('normal project metadata and explicitly trusted Composer execution still work', async t => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root,'vendor'))
  await fs.writeFile(path.join(root,'vendor/autoload.php'),'<?php function fixture_value() { return 42; }')
  await fs.writeFile(path.join(root,'composer.json'),JSON.stringify({require:{'example/library':'^1'}}))
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'fixture-node'}))
  const metadata = await validateProject(root)
  assert.equal(metadata.valid,true)
  assert.equal(metadata.isLaravel,false)
  assert.equal(metadata.nodeProjectName,'fixture-node')
  const runtime = await detectPhpBinary()
  if (!runtime.ok) return t.skip('PHP unavailable for execution control')
  const result = await runPhp('fixture_value()', {phpPath:runtime.path,cwd:root,autoloadPath:metadata.autoloadPath,mode:'composer'})
  assert.equal(result.exitCode,0)
  assert.match(result.stdout,/42/)
})

test('SSH test capture bounds combined output and ignores data after settlement', async () => {
  for (const stream of ['stdout','stderr','both']) {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    let kills = 0
    child.kill = () => {kills++; return true}
    const resultPromise = testSshConnection({host:'example.test'}, {spawnProcess: () => child, maxOutputBytes:1024})
    if (stream === 'both') {child.stdout.write('a'.repeat(600)); child.stderr.write('b'.repeat(600))}
    else child[stream].write('x'.repeat(2000))
    const result = await resultPromise
    assert.equal(result.ok, false)
    assert.match(result.error, /output.*limit/i)
    assert.equal(kills, 1)
    child.stdout.write('late'.repeat(1000)); child.stderr.write('late'.repeat(1000)); child.emit('close',0)
    assert.ok(Buffer.byteLength(result.error)<2048)
  }
})

test('all SSH operations require previously verified host keys', () => {
  const args = buildSshArgs({host:'example.test',user:'deploy',port:2222}, 'php -v')
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(!args.some(arg => arg.includes('accept-new')))
})

test('PHP scientific-number highlighting is linear for long integer tokens', () => {
  let grammar
  registerPhpSnippetLanguage({languages:{register(){},setLanguageConfiguration(){},setMonarchTokensProvider(_id,value){grammar=value}}})
  const rule = grammar.tokenizer.root.find(([regex, token]) => token === 'number.float.php' && regex.source.includes('[eE]'))[0]
  assert.ok(!rule.source.includes('\\d*\\d+'))
  assert.ok(rule.test('123e+10'))
  const started = performance.now()
  assert.equal(new RegExp(`^(?:${rule.source})`).test('9'.repeat(19999)), false)
  assert.ok(performance.now()-started<100)
})

test('automatic indexing rejects external roots and nested symlink escapes', async t => {
  const runtime = await detectPhpBinary()
  if (!runtime.ok) return t.skip('PHP unavailable')
  const base = await fixture(t), root = path.join(base,'project'), outside = path.join(base,'project-sibling')
  await fs.mkdir(path.join(root,'app'),{recursive:true}); await fs.mkdir(outside)
  await fs.writeFile(path.join(root,'app/Safe.php'),'<?php namespace App; class Safe {}')
  await fs.writeFile(path.join(outside,'Secret.php'),'<?php namespace External; class Secret {}')
  if (process.platform !== 'win32') {
    await fs.symlink(outside,path.join(root,'app/escaped'))
    await fs.mkdir(path.join(root,'shared'))
    await fs.writeFile(path.join(root,'shared/Real.php'),'<?php namespace App; class Alias {}')
    await fs.symlink(path.join(root,'shared/Real.php'),path.join(root,'app/Alias.php'))
    await fs.mkdir(path.join(root,'shared-dir'))
    await fs.writeFile(path.join(root,'shared-dir/Widget.php'),'<?php namespace App\\AliasDir; class Widget {}')
    await fs.symlink(path.join(root,'shared-dir'),path.join(root,'app/AliasDir'))
  }
  await fs.writeFile(path.join(root,'composer.json'), JSON.stringify({autoload:{'psr-4':{'App\\':'app/','External\\':outside,'Traversal\\':'../project-sibling'}}}))
  const scan = await scanClasses(root,{phpPath:runtime.path})
  assert.ok(scan.classes.some(entry=>entry.fqcn==='App\\Safe'))
  if (process.platform !== 'win32') assert.ok(scan.classes.some(entry=>entry.fqcn==='App\\Alias'))
  if (process.platform !== 'win32') assert.ok(scan.classes.some(entry=>entry.fqcn==='App\\AliasDir\\Widget'))
  assert.ok(!scan.classes.some(entry=>entry.shortName==='Secret'))
  assert.ok(scan.blockedRoots.includes(await fs.realpath(outside)))
})

test('class cache files and directories are private on POSIX', async t => {
  if (process.platform === 'win32') return t.skip('POSIX mode assertion')
  const root = await fixture(t)
  await saveScanToDisk(root,'/project',{classes:[],count:0,scannedAt:Date.now(),installedMtime:0})
  const dir = path.join(root,'class-cache'), files = await fs.readdir(dir)
  assert.equal((await fs.stat(dir)).mode & 0o777,0o700)
  assert.equal((await fs.stat(path.join(dir,files[0]))).mode & 0o777,0o600)
})

test('legacy class caches are invalidated after scanner security changes', async t => {
  const root = await fixture(t)
  await saveScanToDisk(root,'/project',{classes:[],count:0,scannedAt:Date.now(),installedMtime:0})
  assert.ok(await loadCachedScan(root,'/project'))
  const dir = path.join(root,'class-cache'), [name] = await fs.readdir(dir)
  const file = path.join(dir,name), data = JSON.parse(await fs.readFile(file,'utf8'))
  delete data.cacheSchema
  await fs.writeFile(file,JSON.stringify(data))
  assert.equal(await loadCachedScan(root,'/project'),null)
})

test('indexing revalidates files when a source directory changes during a scan', async t => {
  if (process.platform === 'win32') return t.skip('POSIX directory replacement fixture')
  const runtime = await detectPhpBinary()
  if (!runtime.ok) return t.skip('PHP unavailable')
  const base = await fixture(t), root = path.join(base,'project'), outside = path.join(base,'outside')
  const source = path.join(root,'src'), parked = path.join(root,'parked'), link = path.join(root,'link')
  await fs.mkdir(source,{recursive:true}); await fs.mkdir(outside)
  await fs.writeFile(path.join(root,'composer.json'),JSON.stringify({autoload:{classmap:['src/']}}))
  for (let i=0;i<150;i++) {
    await fs.writeFile(path.join(source,`${i}.php`),`<?php namespace App; class Safe${i} {}`)
    await fs.writeFile(path.join(outside,`${i}.php`),`<?php namespace App; class Outside${i} {}`)
  }
  await fs.symlink(outside,link)
  let stop = false
  const changing = (async () => {
    while (!stop) {
      await fs.rename(source,parked); await fs.rename(link,source)
      await new Promise(resolve=>setImmediate(resolve))
      await fs.rename(source,link); await fs.rename(parked,source)
    }
  })()
  try {
    for (let i=0;i<5;i++) {
      const scan = await scanClasses(root,{phpPath:runtime.path})
      assert.ok(!scan.classes.some(entry=>entry.shortName.startsWith('Outside')))
    }
  } finally {stop=true; await changing}
})

test('bounded metadata reader rejects sparse, symlink and nonregular files', async t => {
  const root = await fixture(t), sparse = path.join(root,'sparse.json')
  const handle = await fs.open(sparse,'w')
  await handle.truncate(1024*1024*1024); await handle.close()
  await assert.rejects(readBoundedFile(sparse), /size.*limit/)
  if (process.platform !== 'win32') {
    const linked = path.join(root,'linked.json'), fifo = path.join(root,'fifo.json')
    await fs.symlink('/dev/zero',linked)
    execFileSync('mkfifo',[fifo])
    await assert.rejects(readBoundedFile(linked), /regular/)
    await assert.rejects(readBoundedFile(fifo), /regular/)
  }
  const small = path.join(root,'small.json')
  await fs.writeFile(small,'{"ok":true}')
  assert.equal(await readBoundedFile(small),' {"ok":true}'.trim())
})

test('bounded metadata reader enforces bytes even when a file grows after stat', async t => {
  const root = await fixture(t), file = path.join(root,'growing.json')
  await fs.writeFile(file,'abc')
  const originalOpen = fs.open.bind(fs)
  t.mock.method(fs,'open',async (...args) => {
    const handle = await originalOpen(...args), originalRead = handle.read.bind(handle)
    let first = true
    handle.read = async (...readArgs) => {
      if (first) {first = false; await fs.appendFile(file,'x'.repeat(100))}
      return originalRead(...readArgs)
    }
    return handle
  })
  await assert.rejects(readBoundedFile(file,{maxBytes:4}), /size.*limit/)
})

test('oversized PHP source is skipped and indexing reports truncation', async t => {
  const runtime = await detectPhpBinary()
  if (!runtime.ok) return t.skip('PHP unavailable')
  const root = await fixture(t)
  await fs.mkdir(path.join(root,'app'))
  await fs.writeFile(path.join(root,'composer.json'),JSON.stringify({autoload:{'psr-4':{'App\\':'app/'}}}))
  await fs.writeFile(path.join(root,'app/Huge.php'),'<?php class Huge {} /*'+'x'.repeat(3*1024*1024)+'*/')
  const scan = await scanClasses(root,{phpPath:runtime.path})
  assert.equal(scan.classes.length,0)
  assert.equal(scan.truncated,true)
})

test('a bounded successful SSH version test preserves legitimate results', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
  const pending = testSshConnection({host:'trusted.test'}, {spawnProcess: () => child})
  child.stdout.write('PHP 8.4.16 (cli)\nCopyright\n'); child.emit('close',0)
  assert.deepEqual(await pending,{ok:true,error:null,version:'PHP 8.4.16 (cli)',mode:'raw'})
})
