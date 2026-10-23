/**
 * 经 GitHub REST API 发布（api.github.com），用于 git push 通道不可用的网络环境。
 *
 * 前置：`gh auth login` 已登录、package.json 的 repository.url 指向目标仓库。
 * 行为：以本地工作区内容整棵建树 → 以远端 main 为父提交创建提交 → PATCH main →
 *       同步 v 标签（存在则移动）→ 刷新仓库主题。
 * 注意：以远端历史为父，本地 git 历史不参与；发布前请先 `npm run build` 并核对改动。
 * 用法：npm run publish:api [-- "commit message"]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const m = /github\.com[/:](.+?)(\.git)?$/i.exec(pkg.repository?.url ?? '')
if (!m) {
  console.error('package.json repository.url 未指向 GitHub 仓库')
  process.exit(1)
}
const REPO = m[1]
// walk 只按名字排除（文件与目录通用）；HANDOFF.md 是内部交接文档，不入公开仓库
const SKIP = new Set(['.git', 'node_modules', 'build', 'HANDOFF.md'])
const DEFAULT_BRANCH = 'main'
const VERSION_TAG = `v${pkg.version}`

function gh(path, body, method = 'POST') {
  const args = ['api', path, '--method', method]
  if (body) args.push('--input', '-')
  const out = execFileSync('gh', args, {
    input: body ? JSON.stringify(body) : undefined,
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  })
  return out.trim() ? JSON.parse(out) : null
}

// 大文件 blob 走 Node fetch 直连 API（gh api --input 对 ~20MB+ 载荷有自身上限）
function ghToken() {
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
}
let token = null
async function uploadBlob(path, filePath) {
  token ??= ghToken()
  const content = readFileSync(filePath).toString('base64')
  // 瞬态网络错误自动重试（malformed/连接中断等），每次间隔递增
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/git/blobs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, encoding: 'base64' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(`blob ${path}: HTTP ${res.status} ${json.message ?? ''}`)
      return json
    } catch (err) {
      lastErr = err
      if (attempt < 3) {
        console.log(`retry ${attempt}/2 for ${path}`)
        await new Promise((r) => setTimeout(r, 5000 * attempt))
      }
    }
  }
  throw lastErr
}

function walk(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

// ---- 0) 仓库为空时先放种子提交（Git Data API 要求非空） ----
let parentSha = null
try {
  parentSha = gh(`/repos/${REPO}/git/refs/heads/${DEFAULT_BRANCH}`, null, 'GET').object.sha
  console.log(`parent ${parentSha}`)
} catch {
  const readme = readFileSync(join(ROOT, 'README.md')).toString('base64')
  const seed = gh(`/repos/${REPO}/contents/README.md`, { message: 'chore: init repository', content: readme }, 'PUT')
  parentSha = seed.commit.sha
  console.log(`seed ${parentSha}`)
}

// ---- 0.5) 内容未变的文件直接复用远端 blob，不再上传 ----
// 大 blob（~17MB 分卷）经本机网络直传易被损坏成 HTTP 400 malformed；
// 而 presets 媒体跨版本不变，按 git blob SHA-1 比对远端树即可整体跳过。
const remoteBlobs = new Map()
try {
  const t = gh(`/repos/${REPO}/git/trees/${parentSha}?recursive=1`, null, 'GET')
  for (const e of t.tree ?? []) if (e.type === 'blob') remoteBlobs.set(e.path, e.sha)
} catch (err) {
  console.log(`remote tree unavailable (${err.message}), will upload everything`)
}

function localBlobSha(filePath) {
  const content = readFileSync(filePath)
  const h = createHash('sha1')
  h.update(`blob ${content.length}\0`)
  h.update(content)
  return h.digest('hex')
}

// ---- 1) 整棵树 ----
const tree = []
for (const full of walk(ROOT)) {
  const rel = relative(ROOT, full).split(sep).join('/')
  const sha = localBlobSha(full)
  if (remoteBlobs.get(rel) === sha) {
    tree.push({ path: rel, mode: '100644', type: 'blob', sha })
    console.log(`blob ${rel} -> ${sha.slice(0, 8)} (unchanged, reuse)`)
    continue
  }
  const blob = await uploadBlob(rel, full)
  if (blob.sha !== sha) throw new Error(`blob ${rel}: 上传后 SHA 与本地不符 ${blob.sha} != ${sha}`)
  tree.push({ path: rel, mode: '100644', type: 'blob', sha })
  console.log(`blob ${rel} -> ${blob.sha.slice(0, 8)}`)
}
const treeRes = gh(`/repos/${REPO}/git/trees`, { tree })
console.log(`tree ${treeRes.sha}`)

// ---- 2) 提交并移动分支与标签 ----
const message = process.argv[2] ?? `chore: publish ${new Date().toISOString()}`
const commit = gh(`/repos/${REPO}/git/commits`, { message, tree: treeRes.sha, parents: [parentSha] })
gh(`/repos/${REPO}/git/refs/heads/${DEFAULT_BRANCH}`, { sha: commit.sha, force: true }, 'PATCH')
console.log(`commit ${commit.sha} -> ${DEFAULT_BRANCH}`)

try {
  gh(`/repos/${REPO}/git/refs/tags/${VERSION_TAG}`, null, 'GET')
  gh(`/repos/${REPO}/git/refs/tags/${VERSION_TAG}`, { sha: commit.sha, force: true }, 'PATCH')
} catch {
  gh(`/repos/${REPO}/git/refs`, { ref: `refs/tags/${VERSION_TAG}`, sha: commit.sha })
}
console.log(`tag ${VERSION_TAG} -> ${commit.sha.slice(0, 8)}`)

gh(`/repos/${REPO}/topics`, { names: pkg.keywords?.filter((k) => k.length > 0 && k !== 'plugin') ?? ['dsh-plugin'] }, 'PUT')
console.log('DONE')
