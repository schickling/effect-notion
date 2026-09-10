/**
 * @module @overeng/megarepo
 *
 * Megarepo - A tool for composing multiple git repositories into a unified development environment.
 */

// Config schema
export * from './core/config.ts'

// Services
export * from './store/store.ts'

// Git utilities
export * from './core/git.ts'
// Member mount lifecycle primitives
export * from './composition/mounts/member-mount.ts'
export * from './composition/mounts/member-mount-r6.ts'
export * from './composition/mounts/member-mount-cp-a-schema.ts'
export * from './composition/mounts/member-mount-cp-a.ts'
export * from './composition/overlays/dist-overlay-schema.ts'
export * from './composition/overlays/dist-overlay-lifecycle-schema.ts'
export * from './composition/overlays/dist-overlay-lifecycle.ts'

// Composition generation and reconciliation

// Serialized workspace update lock and capability resolution
export * from './composition/apply/workspace-update-lock-schema.ts'
export * from './composition/apply/workspace-update-lock.ts'
export * from './composition/capabilities/composition-capability-resolver-schema.ts'
export * from './composition/capabilities/composition-capability-resolver.ts'
export * from './composition/apply/composition-apply-schema.ts'
export * from './composition/apply/composition-apply.ts'
export * from './composition/capabilities/owned-capability-projection.ts'
export * from './composition/apply/composition-runtime.ts'

// Pure Buck composition-root projection
export * from './composition/root/composition-root.ts'
export * from './composition/root/composition-root-publisher.ts'
