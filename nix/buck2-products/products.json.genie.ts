import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { javaScriptProductPublications } from '../../genie/buck2/javascript-product-registry.ts'

/**
 * Publication spec for the tracked Buck product artifacts.
 *
 * The spec is the authority for WHICH products must be published and under
 * which tracked filenames; `manifest.json` beside it is the authority for the
 * exact published bytes. The freshness gate compares both against Buck.
 */
const spec = {
  schema: 'effect-utils/tracked-buck-products-spec/v1',
  generator: 'nix/buck2-products/products.json.genie.ts',
  regenerate: 'devenv tasks run genie:run',
  products: javaScriptProductPublications.map((publication) => ({
    descriptorPath: `${publication.productName}/product.json`,
    label: publication.label,
    module: publication.module,
    productKind: publication.productKind,
    productName: publication.productName,
    runtimeKind: publication.runtimeKind,
  })),
}

export default createGenieOutput({
  data: spec,
  stringify: () => `${JSON.stringify(spec, null, 2)}\n`,
})
