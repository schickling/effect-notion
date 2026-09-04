/** Vendored from effect-distributed-lock 0.0.11 (MIT, Copyright (c) 2025 Ethan Niser). See NOTICE. */
import { Data } from 'effect'

/** Error raised when an acquired lock is lost before the protected effect completes. */
export class LockLostError extends Data.TaggedError('LockLostError')<{
  readonly key: string
}> {
  override get message() {
    return `Permits for "${this.key}" were lost (TTL expired or taken by another holder)`
  }
}

/** Error raised when a blocking acquire attempt cannot obtain permits. */
export class LockNotAcquiredError extends Data.TaggedError('LockNotAcquiredError')<{
  readonly key: string
}> {
  override get message() {
    return `Lock for "${this.key}" was not acquired`
  }
}
