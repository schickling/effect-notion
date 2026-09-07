import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

const publicationEntry = new URL('./src/mod.ts', import.meta.url).pathname
const storybookPreviewEntry = new URL('./.storybook/preview.tsx', import.meta.url).pathname
const resetStylesheet = new URL('./src/styles.css', import.meta.url).pathname

const includePublicationReset = {
  name: 'effect-schema-form-aria:publication-reset',
  apply: 'build',
  enforce: 'pre',
  // oxlint-disable-next-line overeng/named-args -- Vite's Plugin transform hook has a fixed positional signature.
  transform: (code, id) =>
    id === publicationEntry
      ? { code: `import ${JSON.stringify(resetStylesheet)}\n${code}`, map: null }
      : undefined,
} satisfies Plugin

export default defineConfig({
  plugins: [
    includePublicationReset,
    // Both surfaces are named because the compiled StyleX stylesheet is a
    // virtual module that only lands in a bundle where an entry imports it, and
    // the Storybook builder merges this config rather than supplying its own.
    createStylexVitePlugins({
      entries: [publicationEntry, storybookPreviewEntry],
      useCSSLayers: { before: ['overeng.reset'] },
    }),
    react(),
  ],
  build: {
    emptyOutDir: false,
    lib: {
      entry: publicationEntry,
      formats: ['es'],
      fileName: 'mod',
      cssFileName: 'styles',
    },
    rolldownOptions: {
      external: [
        /^@overeng\/effect-schema-form(?:\/|$)/,
        /^@stylexjs\/stylex(?:\/|$)/,
        /^effect(?:\/|$)/,
        /^react(?:\/|$)/,
        /^react-aria-components(?:\/|$)/,
      ],
    },
    sourcemap: true,
  },
})
