/** Vendored from effect-distributed-lock 0.0.11 (MIT, Copyright (c) 2025 Ethan Niser). See NOTICE. */
/** Backing-store contract and errors. */
export * as Backing from './Backing.ts'
export { DistributedSemaphoreBacking, SemaphoreBackingError } from './Backing.ts'
/** Semaphore constructors and operations. */
export * as DistributedSemaphore from './DistributedSemaphore.ts'
export { LockLostError, LockNotAcquiredError } from './Errors.ts'
