// Copies the TON Connect UI bundle next to the pay page assets (served at /static/ on the hosted site).
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const require = createRequire(import.meta.url)
const root = dirname(dirname(require.resolve('@tonconnect/ui')))
mkdirSync('public/static', { recursive: true })
copyFileSync(join(root, 'dist', 'tonconnect-ui.min.js'), 'public/static/tonconnect-ui.min.js')
console.log('copied tonconnect-ui.min.js')
