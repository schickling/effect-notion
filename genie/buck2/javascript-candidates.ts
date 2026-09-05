import { createGenieOutput, type GenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'

const quote = (value: string): string => JSON.stringify(value)

export type JavaScriptProduct =
  | {
      readonly entrypoint: string
      readonly external?: readonly string[]
      readonly externalCapabilities?: readonly string[]
      readonly kind: 'cli'
      readonly output: string
      readonly packageTree?: string
      readonly productName: string
      readonly smokeArgs: readonly string[]
      readonly runtime?: 'bun' | 'node'
      readonly targetName: string
    }
  | {
      readonly entrypoint: string
      readonly external?: readonly string[]
      readonly externalCapabilities?: readonly string[]
      readonly kind: 'module'
      readonly output: string
      readonly packageTree?: string
      readonly productName: string
      readonly runtime?: 'bun' | 'node'
      readonly targetName: string
    }

export type JavaScriptCandidates = {
  readonly storybookPort?: number
  readonly declarations?: string
  readonly products?: readonly JavaScriptProduct[]
}

const list = (values: readonly string[]): string => `[${values.map(quote).join(', ')}]`

const renderProduct = (product: JavaScriptProduct): string => {
  const packageTree = product.packageTree ?? ':package_tree'
  const moduleName = `${product.targetName}-module`
  // A CLI bundle is the executed program entry, so its `import.meta.main`
  // guard must stay true while imported modules keep theirs false.
  const module = `package_bin_artifact(
    name = ${quote(moduleName)},
    entrypoint = ${quote(product.entrypoint)},
    external = ${list(product.external ?? [])},
    external_capabilities = ${list(product.externalCapabilities ?? [])},
    kind = ${quote(product.kind)},
    output = ${quote(product.output)},
    package_tree = ${quote(packageTree)},
    target = ${quote(product.runtime ?? 'node')},
    visibility = ["PUBLIC"],
)`
  if (product.kind === 'module') {
    return `${module}

module_product(
    name = ${quote(product.targetName)},
    module = ${quote(`:${moduleName}`)},
    product_name = ${quote(product.productName)},
    visibility = ["PUBLIC"],
)

package_bin_check(
    name = ${quote(`${product.targetName}-smoke`)},
    entrypoint = ${quote(product.entrypoint)},
    external_capabilities = ${list(product.externalCapabilities ?? [])},
    package_tree = ${quote(packageTree)},
    visibility = ["PUBLIC"],
)`
  }

  if (product.runtime === 'bun') {
    return `${module}

bun_cli_product(
    name = ${quote(product.targetName)},
    module = ${quote(`:${moduleName}`)},
    product_name = ${quote(product.productName)},
    visibility = ["PUBLIC"],
)

alias(
    name = ${quote(`${product.targetName}-launch`)},
    actual = ${quote(`:${product.targetName}`)},
    visibility = ["PUBLIC"],
)

package_bin_check(
    name = ${quote(`${product.targetName}-smoke`)},
    args = ${list(product.smokeArgs)},
    entrypoint = ${quote(product.entrypoint)},
    external_capabilities = ${list(product.externalCapabilities ?? [])},
    package_tree = ${quote(packageTree)},
    visibility = ["PUBLIC"],
)`
  }

  const launchName = `${product.targetName}-launch`
  return `${module}

node_package_bin(
    name = ${quote(launchName)},
    external_capabilities = ${list(product.externalCapabilities ?? [])},
    module = ${quote(`:${moduleName}`)},
    visibility = ["PUBLIC"],
)

cli_product(
    name = ${quote(product.targetName)},
    launch = ${quote(`:${launchName}`)},
    product_name = ${quote(product.productName)},
    visibility = ["PUBLIC"],
)

package_bin_check(
    name = ${quote(`${product.targetName}-smoke`)},
    args = ${list(product.smokeArgs)},
    entrypoint = ${quote(product.entrypoint)},
    external_capabilities = ${list(product.externalCapabilities ?? [])},
    package_tree = ${quote(packageTree)},
    visibility = ["PUBLIC"],
)`
}
/** Appends package-local candidate targets while retaining the canonical TypeScript projection. */
export const withJavaScriptCandidates = ({
  projection,
  storybookPort,
  products = [],
  declarations = '',
}: JavaScriptCandidates & { readonly projection: GenieOutput<unknown> }): GenieOutput<unknown> =>
  createGenieOutput({
    data: projection.data,
    meta: projection.meta,
    validate: projection.validate,
    stringify: (context) => {
      const targets = [
        storybookPort === undefined
          ? ''
          : `storybook_candidates(\n    name = "storybook",\n    package_tree = ":package_tree",\n    port = ${storybookPort},\n)\n`,
        declarations,
        ...products.map(renderProduct),
      ]
        .filter((part) => part.length > 0)
        .join('\n')
      if (targets.length === 0) return projection.stringify(context)
      return `load("//buck2:package_tools.bzl", "node_package_bin", "package_bin", "package_bin_artifact", "package_bin_build", "package_bin_check", "storybook_candidates")
load("//buck2:products.bzl", "bun_cli_product", "cli_product", "module_product")
${projection.stringify(context)}
${targets}`
    },
  })

/** Renders a Starlark string literal for package-local custom candidate declarations. */
export const buckString = quote
