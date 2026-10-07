// 行为测试入口：用 esbuild JS API 打包 TS 用例后直接用 node 跑，不依赖额外测试框架。
import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./behavior.test.ts', import.meta.url))
const outfile = fileURLToPath(new URL('./.behavior.tmp.mjs', import.meta.url))
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'warning',
})
try {
  await import(outfile)
} finally {
  await rm(outfile, { force: true })
}
