#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const root = process.argv[2]
if (root === undefined) {
  console.error(`usage: ${process.argv[1]} REPO_ROOT`)
  process.exit(2)
}

const evaluatedTaskJson = process.env.DEVENV_TASKS_JSON
let taskJson
if (evaluatedTaskJson === undefined) {
  const devenv = process.env.DEVENV_BIN ?? 'devenv'
  const result = spawnSync(devenv, ['--no-reload', 'tasks', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DEVENV_TUI: 'false' },
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    console.error(`devenv tasks list --json failed with exit ${result.status}`)
    process.exit(result.status ?? 1)
  }
  taskJson = result.stdout
} else {
  taskJson = readFileSync(evaluatedTaskJson, 'utf8')
}

let document
try {
  document = JSON.parse(taskJson)
} catch (error) {
  console.error('devenv tasks list --json did not return valid JSON')
  console.error(error)
  process.exit(1)
}

const rawTasks =
  Array.isArray(document) === true
    ? document.map((task) => [task.name, task])
    : Array.isArray(document.tasks) === true
      ? document.tasks.map((task) => [task.name, task])
      : Object.entries(document.tasks ?? document)

const tasks = new Map()
for (const [key, value] of rawTasks) {
  if (value === null || typeof value !== 'object') continue
  const name = value.name ?? key
  if (typeof name !== 'string') continue
  tasks.set(name, value)
}

const dependencyName = (dependency) => {
  const value = typeof dependency === 'string' ? dependency : dependency?.name
  if (typeof value !== 'string') return undefined
  return value.replace(/@(started|ready|succeeded|completed)$/, '')
}
const dependencies = new Map([...tasks.keys()].map((name) => [name, new Set()]))
const ensureTask = (name) => {
  if (dependencies.has(name) === false) dependencies.set(name, new Set())
}
for (const [name, task] of tasks) {
  for (const dependency of task.after ?? []) {
    const upstream = dependencyName(dependency)
    if (upstream === undefined) continue
    ensureTask(upstream)
    dependencies.get(name).add(upstream)
  }
  for (const dependency of task.before ?? []) {
    const downstream = dependencyName(dependency)
    if (downstream === undefined) continue
    ensureTask(downstream)
    dependencies.get(downstream).add(name)
  }
}

let testCount = 0
const ok = ({ condition, name, detail = '' }) => {
  if (condition === false) {
    console.error(`not ok ${testCount + 1} - ${name}${detail === '' ? '' : `: ${detail}`}`)
    process.exit(1)
  }
  testCount += 1
  console.log(`ok ${testCount} - ${name}`)
}
const requireTask = (name) => {
  const task = tasks.get(name)
  ok({ condition: task !== undefined, name: `evaluated graph contains ${name}` })
  return task
}
const reaches = ({ start, target }) => {
  const seen = new Set()
  const visit = (name) => {
    if (name === target) return true
    if (seen.has(name) === true) return false
    seen.add(name)
    return [...(dependencies.get(name) ?? [])].some(visit)
  }
  return visit(start)
}

for (const name of [
  'check:quick',
  'check:all',
  'buck2:check',
  'buck2:sandbox-gate:fresh',
  'buck2:typescript:materialize-dist',
  'buck2:tui-core:publish-editor',
  'buck2:tui-core:check-editor',
])
  requireTask(name)

for (const name of ['ts:check', 'ts:check:strict', 'ts:build', 'ts:build-watch'])
  ok({
    condition: tasks.has(name) === false,
    name: `${name} no longer exists: TypeScript authority is Buck-owned`,
  })

const visiting = new Set()
const visited = new Set()
const visitAcyclic = (name) => {
  if (visiting.has(name) === true) throw new Error(`cycle reaches ${name}`)
  if (visited.has(name) === true) return
  visiting.add(name)
  for (const dependency of dependencies.get(name) ?? []) visitAcyclic(dependency)
  visiting.delete(name)
  visited.add(name)
}
try {
  for (const name of dependencies.keys()) visitAcyclic(name)
  ok({ condition: true, name: 'evaluated task graph is acyclic' })
} catch (error) {
  ok({ condition: false, name: 'evaluated task graph is acyclic', detail: error.message })
}

const materializer = 'buck2:typescript:materialize-dist'
for (const name of ['check:quick', 'check:all', 'buck2:check']) {
  ok({
    condition: reaches({ start: name, target: materializer }),
    name: `${name} reaches ${materializer}`,
  })
}
for (const name of ['check:quick', 'check:all']) {
  ok({
    condition: reaches({ start: name, target: 'buck2:check' }),
    name: `${name} gates on the Buck typecheck aggregate`,
  })
}
// `mr apply` both reconciles the workspace and installs the `.buck2/capabilities`
// projection that Buck analysis of `//buck2/toolchains` reads, so it is the single
// ordering barrier for every task that invokes Buck.
for (const name of [
  materializer,
  'buck2:check',
  'buck2:sandbox-gate:fresh',
  'buck2:editor-authority',
  'buck2:tui-core:publish-editor',
  'buck2:tui-core:check-editor',
  'buck2:nix-bridge:check',
]) {
  ok({
    condition: reaches({ start: name, target: 'mr:apply' }),
    name: `${name} waits for workspace reconciliation and the capability projection`,
  })
}

const source = readFileSync(`${root}/devenv.nix`, 'utf8')
const taskSource = (name) => {
  const start = source.indexOf(`  tasks."${name}" = {`)
  ok({ condition: start !== -1, name: `devenv.nix contains ${name}` })
  const end = source.indexOf('\n  tasks."', start + 1)
  return source.slice(start, end === -1 ? source.length : end)
}

const materializerSource = taskSource(materializer)
const typescriptAuthorityRuntimePath = 'genie/buck2/typescript-authority-runtime.ts'
const typescriptAuthorityRuntimeTarget = 'effect_utils//genie/buck2:typescript-authority-runtime'
const typescriptAuthorityRuntimeSource = readFileSync(
  `${root}/${typescriptAuthorityRuntimePath}`,
  'utf8',
)
ok({
  condition:
    materializerSource.includes(typescriptAuthorityRuntimeTarget) === true &&
    materializerSource.includes('materialize-dist "$root"') === true &&
    materializerSource.includes('BUCK2_BIN=') === true,
  name: 'materializer dispatches the registry-backed TypeScript authority runtime',
})
ok({
  condition:
    typescriptAuthorityRuntimeSource.includes('authoritativeBuck2TypeScriptAdmissions') === true &&
    typescriptAuthorityRuntimeSource.includes('admissions.map(') === true &&
    typescriptAuthorityRuntimeSource.includes('scripts/typescript-materialize-dist.sh') === true &&
    typescriptAuthorityRuntimeSource.includes('packages/@overeng/tui-core') === false &&
    typescriptAuthorityRuntimeSource.includes('packages/@overeng/tui-react') === false,
  name: 'TypeScript authority runtime derives materialization from the registry',
})
ok({
  condition:
    materializerSource.includes('.megarepo-owned-worktree.json') === false &&
    materializerSource.includes('TYPESCRIPT_DIST_MODE') === false &&
    materializerSource.includes('TSGO_BIN') === false &&
    materializerSource.includes('DIFF_BIN') === false &&
    materializerSource.includes('WORKSPACE_ROOT=') === true,
  name: 'materializer publishes unconditionally from the composition root with no tsgo fallback',
})
const materializerScriptSource = readFileSync(
  `${root}/scripts/typescript-materialize-dist.sh`,
  'utf8',
)
ok({
  condition:
    materializerScriptSource.includes('TYPESCRIPT_DIST_MODE') === false &&
    materializerScriptSource.includes('TSGO_BIN') === false &&
    materializerScriptSource.includes('DIFF_BIN') === false,
  name: 'declaration materializer script has no direct-tsgo check mode',
})

for (const name of ['buck2:tui-core:publish-editor', 'buck2:tui-core:check-editor']) {
  const task = taskSource(name)
  ok({
    condition: task.includes('--isolation-dir') === false,
    name: `${name} has no dynamic isolation directory`,
  })
  ok({ condition: /buck2[^\n]*\bkill\b/.test(task) === false, name: `${name} has no daemon kill` })
  ok({ condition: task.includes('buck-out') === false, name: `${name} has no buck-out cleanup` })
}

const buckCheckSource = taskSource('buck2:check')
ok({
  condition:
    buckCheckSource.includes('realpath "$root/../.."') === true &&
    buckCheckSource.includes('$workspace_root/.megarepo/bin/buck2') === true &&
    buckCheckSource.includes(typescriptAuthorityRuntimeTarget) === true &&
    buckCheckSource.includes('build "$buck"') === true,
  name: 'buck2:check resolves the composition wrapper and dispatches the authority runtime',
})
const sandboxGateSource = taskSource('buck2:sandbox-gate:fresh')
ok({
  condition:
    sandboxGateSource.includes('--isolation-dir') === true &&
    sandboxGateSource.includes('--no-remote-cache') === true &&
    sandboxGateSource.includes('${RANDOM}') === true &&
    sandboxGateSource.includes('buck2Machine') === true &&
    sandboxGateSource.includes('sandbox-gate:denies_undeclared_store_metadata') === true,
  name: 'sandbox admission uses a fresh local cache namespace and every controlled gate',
})
const buckToolchainSource = readFileSync(`${root}/buck2/toolchains/BUCK`, 'utf8')
ok({
  condition:
    buckToolchainSource.includes('bun_toolchain(') === true &&
    buckToolchainSource.includes('name = "archive_tool"') === true,
  name: 'Buck toolchains live in the buck2/toolchains package',
})
ok({
  condition: existsSync(`${root}/toolchains`) === false,
  name: 'no legacy top-level toolchains directory remains',
})

console.log(`1..${testCount}`)
