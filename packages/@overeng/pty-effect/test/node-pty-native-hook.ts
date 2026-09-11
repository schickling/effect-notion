import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = process.env.NODE_PTY_NATIVE_PACKAGE
if (packageRoot === undefined || isAbsolute(packageRoot) === false) {
  throw new Error('NODE_PTY_NATIVE_PACKAGE must name the absolute Nix node-pty package root')
}

const entrypoint = resolve(packageRoot, 'lib/index.js')
if (existsSync(entrypoint) === false) {
  throw new Error(`NODE_PTY_NATIVE_PACKAGE has no lib/index.js: ${packageRoot}`)
}
const entrypointUrl = pathToFileURL(entrypoint).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node-pty') return { shortCircuit: true, url: entrypointUrl }
    return nextResolve(specifier, context)
  },
})
