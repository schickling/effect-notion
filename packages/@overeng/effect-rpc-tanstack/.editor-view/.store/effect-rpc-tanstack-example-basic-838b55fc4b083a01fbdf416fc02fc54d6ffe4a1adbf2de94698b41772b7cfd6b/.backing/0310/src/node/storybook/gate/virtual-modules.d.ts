/**
 * Emitted by the Storybook Vite builder that `storybookTest` installs, so it
 * exists only inside a gate run and has no shipped types. This is the same
 * module `@storybook/addon-vitest`'s own setup file imports.
 */
declare module 'virtual:/@storybook/builder-vite/project-annotations.js' {
  /** The composed preview annotations: the consumer's `preview` plus its addons. */
  export const getProjectAnnotations: () => object | readonly object[]
}
