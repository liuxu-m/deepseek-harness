// Rasterize apps/web/public/favicon.svg into desktop icons (PNG + ICO).
// Uses the sharp install under desktop/tool (see build.ps1 for why npm there).
// Run from the repository root: node desktop/tool/make-icon.mjs
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sharp = require(resolve(import.meta.dirname, 'node_modules/sharp'))

const root = resolve(import.meta.dirname, '../..')
const svg = readFileSync(resolve(root, 'apps/web/public/favicon.svg'), 'utf8')
const pathData = svg.match(/<path[^>]*d="([^"]+)"/)?.[1]
if (!pathData) throw new Error('favicon.svg: path data not found')

// Force a white glyph on a deep navy field; the favicon's own dark-mode media
// query does not apply inside a plain <svg> buffer, so the fill is explicit.
const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">`
  + `<g transform="translate(3,3) scale(0.88)">`
  + `<path fill="#ffffff" d="${pathData}"/>`
  + `</g></svg>`

const output = resolve(root, 'desktop/assets')
await sharp(Buffer.from(glyph))
  .resize(1024, 1024)
  .flatten({ background: '#0b1220' })
  .png()
  .toFile(resolve(output, 'icon.png'))
await sharp(Buffer.from(glyph))
  .resize(256, 256)
  .flatten({ background: '#0b1220' })
  .toFile(resolve(output, 'icon.ico'))
console.log('icon.png + icon.ico written to', output)
