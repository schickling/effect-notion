// @genie-bootstrap
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { loadRealPnpmLockData } from './generate.ts'

const { sidecar } = loadRealPnpmLockData()

export default createGenieOutput({
  data: sidecar,
  stringify: () => `${JSON.stringify(sidecar, null, 2)}\n`,
})
