// Preserve dependency notices even when code is bundled into renderer/main chunks.
import { promises as fs } from 'node:fs'
import path from 'node:path'

const notices = ['PHP Tinker third-party notices', '', 'This file conservatively includes notices from installed build and runtime packages.', 'Electron additionally supplies its own runtime license files in the application bundle.', '']
async function packages(directory) {
  let entries
  try { entries = await fs.readdir(directory, {withFileTypes:true}) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const folder = path.join(directory,entry.name)
    if (entry.name.startsWith('@')) {await packages(folder); continue}
    let pkg
    try {pkg=JSON.parse(await fs.readFile(path.join(folder,'package.json'),'utf8'))} catch {continue}
    const files = (await fs.readdir(folder,{withFileTypes:true})).filter(file=>file.isFile() && /^(license|licence|copying|notice|thirdpartynotices)([.\-_]|$)/i.test(file.name))
    for (const file of files.sort((a,b)=>a.name.localeCompare(b.name))) {
      notices.push('='.repeat(72), pkg.name+'@'+pkg.version+' — '+file.name, '', await fs.readFile(path.join(folder,file.name),'utf8'), '')
    }
    await packages(path.join(folder,'node_modules'))
  }
}
await packages(path.resolve('node_modules'))
await fs.writeFile('THIRD_PARTY_NOTICES.txt',notices.join('\n'))
console.log('Generated third-party notices for the installed dependency tree')
