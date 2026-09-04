export {
  Backing,
  DistributedSemaphore,
  DistributedSemaphoreBacking,
  LockLostError,
  SemaphoreBackingError,
} from '@overeng/effect-distributed-lock'

/** In-memory backing for distributed semaphore (useful for tests) */
export * as InMemoryBacking from '../isomorphic/in-memory-backing.ts'
