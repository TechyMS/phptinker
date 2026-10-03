const fs = require('node:fs')
const path = require('node:path')

const brandedElectron = path.resolve(
  __dirname,
  '../node_modules/.phptinker-electron/PHP Tinker.app/Contents/MacOS/PHP Tinker'
)

module.exports = fs.existsSync(brandedElectron)
  ? brandedElectron
  : require('electron')
