import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    kind: { type: 'string' },
    output: { type: 'string' },
    path: { type: 'string', multiple: true },
    source: { type: 'string' },
    tool: { type: 'string' },
  },
  strict: true,
})

const { kind, output, path: paths, source, tool } = values
if (kind !== 'format' && kind !== 'lint') throw new Error(`unsupported static check kind: ${kind}`)
if (output === undefined) throw new Error('missing --output')
if (paths === undefined || paths.length === 0) throw new Error('missing --path')
if (source === undefined) throw new Error('missing --source')
if (tool === undefined) throw new Error('missing --tool')
const args =
  kind === 'format'
    ? ['--check', '--config=.oxfmtrc.json', '--disable-nested-config', ...paths]
    : [
        '--import-plugin',
        '--type-aware',
        '--tsconfig=tsconfig.lint.json',
        '--deny-warnings',
        ...paths,
      ]
const check = Bun.spawnSync({
  cmd: [path.resolve(tool), ...args],
  cwd: source,
  env: { ...process.env, CI: 'true', DEVENV_TASK_PASSTHROUGH: '1' },
  stdin: 'ignore',
  stdout: 'inherit',
  stderr: 'inherit',
})
if (check.exitCode !== 0) process.exit(check.exitCode)

await Bun.write(output, `${JSON.stringify({ kind, status: 'passed' }, null, 2)}\n`)
