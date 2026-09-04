import { time } from './time.ts'
import type { Timestamp } from './timestamp.ts'

const intlDateTimeFormat = {
  short: new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }),
  narrow: new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'narrow',
    year: 'numeric',
  }),
}

const intlDateTimeFormatRelative = {
  short: new Intl.RelativeTimeFormat('en', {
    numeric: 'auto',
    style: 'short',
  }),
  narrow: new Intl.RelativeTimeFormat('en', {
    numeric: 'auto',
    style: 'narrow',
  }),
}

/** Formats a timestamp as a relative or absolute date string */
export const humanizedDate = ({
  timestamp,
  nowMs,
  style = 'short',
}: {
  timestamp: Timestamp | number
  nowMs: number
  style?: 'short' | 'narrow'
}) => {
  const differenceMs = nowMs - timestamp
  // Sometimes the timestamp is the future (e.g. for upcoming releases)
  const differenceMsAbs = Math.abs(differenceMs)

  if (differenceMsAbs < time.min) {
    return intlDateTimeFormatRelative[style].format(-Math.floor(differenceMs / time.sec), 'seconds')
  } else if (differenceMsAbs < time.hour) {
    return intlDateTimeFormatRelative[style].format(-Math.floor(differenceMs / time.min), 'minutes')
  } else if (differenceMsAbs < time.day) {
    return intlDateTimeFormatRelative[style].format(-Math.floor(differenceMs / time.hour), 'hours')
  } else if (differenceMsAbs < 30 * time.day) {
    return intlDateTimeFormatRelative[style].format(-Math.floor(differenceMs / time.day), 'days')
  } else {
    return intlDateTimeFormat[style].format(timestamp)
  }
}

/** Formats a duration in milliseconds as a human-readable string */
export const humanizedDuration = ({
  durationMs,
  style = 'abbreviated',
}: {
  durationMs: number
  style?: 'abbreviated' | 'word'
}) => {
  if (durationMs < time.sec) {
    const suffix = style === 'abbreviated' ? 'ms' : ' milliseconds'
    return `${durationMs}${suffix}`
  } else if (durationMs < time.min) {
    const suffix = style === 'abbreviated' ? 'sec' : ' seconds'
    return `${Math.floor(durationMs / time.sec)}${suffix}`
  } else if (durationMs < time.hour) {
    const suffix = style === 'abbreviated' ? 'min' : ' minutes'
    return `${Math.floor(durationMs / time.min)}${suffix}`
  } else if (durationMs < time.day) {
    const suffix = style === 'abbreviated' ? 'h' : ' hours'
    return `${Math.floor(durationMs / time.hour)}${suffix}`
  } else {
    const suffix = style === 'abbreviated' ? 'd' : ' days'
    return `${Math.floor(durationMs / time.day)}${suffix}`
  }
}
