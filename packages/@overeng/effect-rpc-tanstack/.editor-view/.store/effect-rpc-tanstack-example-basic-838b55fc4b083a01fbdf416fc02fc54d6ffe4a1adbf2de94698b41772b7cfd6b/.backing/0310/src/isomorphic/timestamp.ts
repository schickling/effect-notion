import { type Brand, Schema } from 'effect'

/** Unix timestamp integer in milliseconds since epoch */
export type Timestamp = Brand.Branded<number, 'Timestamp'>

/** Converts a number, string, or Date to a Timestamp */
export const timestamp = (value: number | string | Date): Timestamp => {
  if (typeof value === 'number') {
    return Math.round(value) as Timestamp
  } else if (value instanceof Date) {
    return Math.round(value.getTime()) as Timestamp
  } else {
    return Math.round(new Date(value).getTime()) as Timestamp
  }
}

/** Schema for a `Timestamp` carried on the wire as a plain number */
export const timestampSchema = Schema.Finite.pipe(Schema.brand('Timestamp'))

/** Returns the current time as a Timestamp */
export const timestampNow = (): Timestamp => Math.round(Date.now()) as Timestamp
