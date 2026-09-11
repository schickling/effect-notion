/**
 * Emitted by the Storybook Vite plugins loaded by the gate's Portable Stories
 * integration. It exists only inside a gate run and has no shipped types.
 */
declare module 'virtual:/@storybook/builder-vite/project-annotations.js' {
  /** The composed preview annotations: the consumer's `preview` plus its addons. */
  export const getProjectAnnotations: () => object | readonly object[]
}
