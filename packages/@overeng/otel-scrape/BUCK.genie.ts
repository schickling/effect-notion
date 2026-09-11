import { cargoBuck2PackageProjection } from '../../../rust/buck2-tools/core/cargo-buck2-package-projection.ts'

export default cargoBuck2PackageProjection({
  buildProduct: true,
  cliBuildStamp: true,
  sourceUrl: import.meta.url,
})
