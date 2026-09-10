// @genie-bootstrap
import {
  catalog,
  packageJson,
  workspaceMember,
  type PackageJsonData,
} from '../../genie/internal.ts'

const composition = catalog.compose({
  workspace: workspaceMember({ memberPath: 'context/opentui' }),
  dependencies: {
    external: catalog.pick(
      '@effect/atom-react',
      '@opentui/core',
      '@opentui/react',
      'effect',
      'react',
    ),
  },
  devDependencies: {
    // `typescript` is declared even though these examples are never compiled
    // here: `@opentui/core` peers TypeScript, and this was the only OpenTUI
    // importer that left that peer undeclared. pnpm then satisfied it from
    // `bun-ffi-structs`'s `^5` range and installed a second compiler
    // (5.9.3) beside the catalog's, splitting `@opentui/core` into two store
    // entries and adding a third TypeScript to a repo whose duplicate
    // exception admits exactly two.
    external: catalog.pick('@types/node', '@types/react', 'typescript'),
  },
})

export default packageJson(
  {
    name: 'opentui-examples',
    private: true,
    type: 'module',
  } satisfies PackageJsonData,
  composition,
)
