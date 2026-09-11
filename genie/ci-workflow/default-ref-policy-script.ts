export const defaultRefPolicyCheckScript = String.raw`const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')

const cwd = process.cwd()
const firstPartyOwners = new Set(JSON.parse(process.env.FIRST_PARTY_OWNERS_JSON).map((owner) => owner.toLowerCase()))
const defaultRef = process.env.DEFAULT_REF || 'main'
const defaultRefs = new Map(Object.entries(JSON.parse(process.env.DEFAULT_REFS_JSON || '{}')).map(([repo, ref]) => [repo.toLowerCase(), ref]))
const verifyReachable = process.env.VERIFY_REACHABLE === '1'
const allowLegacyMemberCommitRefs = process.env.ALLOW_LEGACY_MEMBER_COMMIT_REFS === '1'
const violations = []

const repoKey = (repo) => repo.owner.toLowerCase() + '/' + repo.repo.toLowerCase()
const isFirstParty = (repo) => firstPartyOwners.has(repo.owner.toLowerCase())
const normalizeGitBranchRefs = process.env.NORMALIZE_GIT_BRANCH_REFS === '1'
const normalizeRef = (ref) => normalizeGitBranchRefs && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
const expectedRefFor = (repo) => normalizeRef(defaultRefs.get(repoKey(repo)) || defaultRef)
const immutableCommitRef = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const isAllowedLegacyMemberRef = ({ memberName, ref }) =>
  allowLegacyMemberCommitRefs &&
  typeof memberName === 'string' &&
  memberName.endsWith('-legacy') &&
  immutableCommitRef.test(ref)

const githubRepoFromUrl = (url) => {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/)
  return match ? { owner: match[1], repo: match[2] } : undefined
}

const parseGithubLikeRef = (value) => {
  const hashIndex = value.indexOf('#')
  const baseWithQuery = hashIndex >= 0 ? value.slice(0, hashIndex) : value
  const hashRef = hashIndex >= 0 ? value.slice(hashIndex + 1) : undefined
  const queryIndex = baseWithQuery.indexOf('?')
  const base = queryIndex >= 0 ? baseWithQuery.slice(0, queryIndex) : baseWithQuery
  const params = new URLSearchParams(queryIndex >= 0 ? baseWithQuery.slice(queryIndex + 1) : '')
  const queryRef = params.get('ref') || undefined

  if (base.startsWith('github:')) {
    const parts = base.slice('github:'.length).split('/')
    if (parts.length < 2) return undefined
    return {
      repo: { owner: parts[0], repo: parts[1] },
      ref: hashRef || queryRef || (parts.length > 2 ? parts.slice(2).join('/') : undefined),
    }
  }

  if (base.startsWith('git+https://github.com/')) {
    const repo = githubRepoFromUrl(base.slice('git+'.length))
    return repo ? { repo, ref: hashRef || queryRef } : undefined
  }

  if (base.startsWith('git+ssh://git@github.com/')) {
    const pathParts = base.slice('git+ssh://git@github.com/'.length).replace(/\.git$/, '').split('/')
    return pathParts.length >= 2
      ? { repo: { owner: pathParts[0], repo: pathParts[1] }, ref: hashRef || queryRef }
      : undefined
  }

  const urlRepo = githubRepoFromUrl(base)
  if (urlRepo) return { repo: urlRepo, ref: hashRef || queryRef }

  if (!value.includes('://') && !value.startsWith('./') && !value.startsWith('../') && !value.startsWith('/')) {
    const parts = base.split('/')
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { repo: { owner: parts[0], repo: parts[1] }, ref: hashRef }
    }
  }

  return undefined
}

const addRefViolation = ({ file, repo, ref, field, inputName, memberName }) => {
  if (!repo || !ref || !isFirstParty(repo)) return
  const expectedRef = expectedRefFor(repo)
  const normalizedRef = normalizeRef(ref)
  if (normalizedRef === expectedRef) return
  if (isAllowedLegacyMemberRef({ memberName, ref: normalizedRef })) return
  violations.push({
    type: 'ref',
    file,
    repo: repoKey(repo),
    ref: normalizedRef,
    expectedRef,
    field,
    inputName,
    memberName,
  })
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

const displayPath = (file) => path.relative(cwd, file) || path.basename(file)
const authorityNames = new Set(['megarepo.kdl', 'megarepo.json', 'megarepo.lock', 'flake.nix', 'flake.lock', 'devenv.yaml', 'devenv.lock'])
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'result', '.devenv', '.direnv', '.next', '.storybook-static'])

const collectAuthorityFiles = (root) => {
  const files = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (ignoredDirs.has(entry)) continue
        if (dir === root && entry === 'repos') continue
        walk(full)
      } else if (stat.isFile() && authorityNames.has(entry)) {
        files.push(full)
      }
    }
  }
  walk(root)
  return files
}

const extractFlakeNixInputs = (content) => {
  const inputs = []
  const directPattern = /(?:inputs\.)?([a-zA-Z0-9_-]+)\.url\s*=\s*"([^"]+)"/g
  let match
  while ((match = directPattern.exec(content)) !== null) {
    inputs.push({ inputName: match[1], url: match[2] })
  }

  const lines = content.split('\n')
  let inInputs = false
  let inputsIndent = -1
  let currentInputName
  let currentInputIndent = -1
  for (const line of lines) {
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length
    if (trimmed.startsWith('inputs = {')) {
      inInputs = true
      inputsIndent = indent
      currentInputName = undefined
      currentInputIndent = -1
      continue
    }
    if (!inInputs) continue
    if (trimmed && indent <= inputsIndent && trimmed.startsWith('};')) {
      inInputs = false
      currentInputName = undefined
      continue
    }
    if (currentInputName && trimmed === '};' && indent <= currentInputIndent) {
      currentInputName = undefined
      continue
    }
    const inputStart = trimmed.match(/^(?:inputs\.)?([a-zA-Z0-9_-]+)\s*=\s*\{\s*$/)
    if (inputStart && indent > inputsIndent) {
      currentInputName = inputStart[1]
      currentInputIndent = indent
      continue
    }
    const urlMatch = trimmed.match(/^url\s*=\s*"([^"]+)"/)
    if (currentInputName && urlMatch) inputs.push({ inputName: currentInputName, url: urlMatch[1] })
  }
  return inputs
}

const extractDevenvYamlInputs = (content) => {
  const inputs = []
  const lines = content.split('\n')
  let inInputs = false
  let inputsIndent = -1
  let currentInputName
  for (const line of lines) {
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length
    if (trimmed === 'inputs:' && !inInputs) {
      inInputs = true
      inputsIndent = indent
      currentInputName = undefined
      continue
    }
    if (!inInputs) continue
    if (trimmed && indent <= inputsIndent && !trimmed.startsWith('#')) {
      inInputs = false
      currentInputName = undefined
      continue
    }
    const inputNameMatch = trimmed.match(/^([a-zA-Z0-9_-]+):$/)
    if (inputNameMatch && indent > inputsIndent) {
      currentInputName = inputNameMatch[1]
      continue
    }
    const urlMatch = trimmed.match(/^url:\s*(.+)$/)
    if (currentInputName && urlMatch) {
      const raw = urlMatch[1].trim()
      const url = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw
      inputs.push({ inputName: currentInputName, url })
    }
  }
  return inputs
}

const lockInputs = (content) => {
  const parsed = readJsonContent(content)
  const rootName = parsed && (parsed.root || 'root')
  const root = parsed && parsed.nodes && parsed.nodes[rootName]
  if (!root || !root.inputs || !parsed.nodes) return []
  return Object.entries(root.inputs).flatMap(([inputName, nodeName]) => {
    const node = parsed.nodes[nodeName]
    return node ? [{ inputName, original: node.original, locked: node.locked }] : []
  })
}

const readJsonContent = (content) => {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

const repoFromLockSection = (section) => {
  if (!section || typeof section !== 'object') return undefined
  if (section.type === 'github' && typeof section.owner === 'string' && typeof section.repo === 'string') {
    return { owner: section.owner, repo: section.repo }
  }
  if (section.type === 'git' && typeof section.url === 'string') return githubRepoFromUrl(section.url)
  if (typeof section.url === 'string') return parseGithubLikeRef(section.url)?.repo || githubRepoFromUrl(section.url)
  return undefined
}

const refFromLockSection = (section) => {
  if (!section || typeof section !== 'object') return undefined
  if (typeof section.ref === 'string') return section.ref
  if (typeof section.url === 'string') return parseGithubLikeRef(section.url)?.ref
  return undefined
}

const roots = [cwd]
const reposRoot = path.join(cwd, 'repos')
if (fs.existsSync(reposRoot)) {
  for (const entry of fs.readdirSync(reposRoot)) {
    roots.push(path.join(reposRoot, entry))
  }
}

for (const root of roots) {
  for (const file of collectAuthorityFiles(root)) {
    const base = path.basename(file)
    const rel = displayPath(file)
    const content = fs.readFileSync(file, 'utf8')

    if (base === 'megarepo.kdl') {
      for (const line of content.split('\n')) {
        const match = line.trim().match(/^([A-Za-z0-9_.-]+)\s+"([^"]+)"/)
        if (!match) continue
        const parsed = parseGithubLikeRef(match[2])
        addRefViolation({ file: rel, repo: parsed && parsed.repo, ref: parsed && parsed.ref, field: 'members.source', memberName: match[1] })
      }
    } else if (base === 'megarepo.lock') {
      const parsed = readJson(file)
      for (const [memberName, member] of Object.entries((parsed && parsed.members) || {})) {
        const repo = typeof member.url === 'string' ? githubRepoFromUrl(member.url) : undefined
        addRefViolation({ file: rel, repo, ref: member.ref, field: 'members.ref', memberName })
      }
    } else if (base === 'flake.nix') {
      for (const input of extractFlakeNixInputs(content)) {
        const parsed = parseGithubLikeRef(input.url)
        addRefViolation({ file: rel, repo: parsed && parsed.repo, ref: parsed && parsed.ref, field: 'url.ref', inputName: input.inputName })
      }
    } else if (base === 'devenv.yaml') {
      for (const input of extractDevenvYamlInputs(content)) {
        const parsed = parseGithubLikeRef(input.url)
        addRefViolation({ file: rel, repo: parsed && parsed.repo, ref: parsed && parsed.ref, field: 'url.ref', inputName: input.inputName })
      }
    } else if (base === 'flake.lock' || base === 'devenv.lock') {
      for (const input of lockInputs(content)) {
        for (const [field, section] of [['original', input.original], ['locked', input.locked]]) {
          addRefViolation({ file: rel, repo: repoFromLockSection(section), ref: refFromLockSection(section), field: field + '.ref', inputName: input.inputName })
        }
      }
    }
  }
}

if (verifyReachable) {
  const lock = readJson(path.join(cwd, 'megarepo.lock'))
  for (const [memberName, member] of Object.entries((lock && lock.members) || {})) {
    const repo = typeof member.url === 'string' ? githubRepoFromUrl(member.url) : undefined
    if (!repo || !isFirstParty(repo)) continue
    if (
      typeof member.ref === 'string' &&
      isAllowedLegacyMemberRef({ memberName, ref: normalizeRef(member.ref) })
    ) {
      continue
    }
    const expectedRef = expectedRefFor(repo)
    const remote = 'https://github.com/' + repo.owner + '/' + repo.repo + '.git'
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'default-ref-policy-'))
    let ok = false
    try {
      cp.execFileSync('git', ['-C', tmp, 'init', '-q'], { stdio: 'ignore' })
      cp.execFileSync('git', ['-C', tmp, 'remote', 'add', 'origin', remote], { stdio: 'ignore' })
      cp.execFileSync('git', ['-C', tmp, 'fetch', '-q', '--filter=blob:none', 'origin', 'refs/heads/' + expectedRef + ':refs/remotes/origin/' + expectedRef], { stdio: 'ignore' })
      cp.execFileSync('git', ['-C', tmp, 'cat-file', '-e', member.commit + '^{commit}'], { stdio: 'ignore' })
      cp.execFileSync('git', ['-C', tmp, 'merge-base', '--is-ancestor', member.commit, 'refs/remotes/origin/' + expectedRef], { stdio: 'ignore' })
      ok = true
    } catch {
      ok = false
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    if (!ok) {
      violations.push({ type: 'reachability', file: 'megarepo.lock', repo: repoKey(repo), rev: member.commit, expectedRef, memberName })
    }
  }
}

if (violations.length === 0) {
  console.log('Default ref policy OK')
  process.exit(0)
}

console.error('Default ref policy failed:')
for (const violation of violations) {
  if (violation.type === 'reachability') {
    console.error('  - ' + violation.file + ': member ' + violation.memberName + ' ' + violation.repo + ' locks ' + violation.rev.slice(0, 12) + " outside '" + violation.expectedRef + "'")
  } else {
    const name = violation.memberName ? ' member ' + violation.memberName : violation.inputName ? ' input ' + violation.inputName : ''
    console.error('  - ' + violation.file + ':' + name + ' ' + violation.repo + " uses ref '" + violation.ref + "' in " + violation.field + "; expected '" + violation.expectedRef + "'")
  }
}
console.error('')
console.error('Fix: merge upstream PRs first, retarget first-party inputs back to their default refs, then refresh locks.')
process.exit(1)`
