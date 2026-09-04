/**
 * Based on:
 *
 * cuid.js
 * Collision-resistant UID generator for browsers and node.
 * Sequential for fast db lookups and recency sorting.
 * Safe for element IDs and server-side lookups.
 *
 * Extracted from CLCTR
 *
 * Copyright (c) Eric Elliott 2012
 * MIT License
 */

import crypto from 'node:crypto'
import os from 'node:os'

/** Collision-resistant unique identifier string */
export type Cuid = string

const lim = 2 ** 32 - 1

const getRandomValue = () => {
  return Math.abs(crypto.randomBytes(4).readInt32BE() / lim)
}

const pad = ({ num, size }: { num: number | string; size: number }) => {
  const s = `000000000${num}`
  return s.slice(s.length - size)
}

const fingerprint = () => {
  const padding = 2
  const pid = pad({ num: process.pid.toString(36), size: padding })
  const hostname = os.hostname()
  const length = hostname.length
  const hostId = pad({
    num: hostname
      .split('')
      .reduce((prev, char) => {
        return +prev + char.charCodeAt(0)
      }, +length + 36)
      .toString(36),
    size: padding,
  })

  return pid + hostId
}

let c = 0
const blockSize = 4
const base = 36
const discreteValues = base ** blockSize

const randomBlock = () => {
  return pad({ num: Math.trunc(getRandomValue() * discreteValues).toString(base), size: blockSize })
}

const safeCounter = () => {
  c = c < discreteValues ? c : 0
  c++ // this is not subliminal
  return c - 1
}

/** Generates a collision-resistant unique identifier suitable for element IDs */
export const cuid = (): Cuid => {
  // Starting with a lowercase letter makes
  // it HTML element ID friendly.
  const letter = 'c' // hard-coded allows for sequential access
  // timestamp
  // warning: this exposes the exact date and time
  // that the uid was created.
  const timestamp = Date.now().toString(base)
  // Prevent same-machine collisions.
  const counter = pad({ num: safeCounter().toString(base), size: blockSize })
  // A few chars to generate distinct ids for different
  // clients (so different computers are far less
  // likely to generate the same id)
  const print = fingerprint()
  // Grab some more chars from Math.random()
  const random = randomBlock() + randomBlock()

  return letter + timestamp + counter + print + random
}

/** Generates a short collision-resistant slug (7-10 characters) */
export const slug = () => {
  const date = Date.now().toString(36)
  const counter = safeCounter().toString(36).slice(-4)
  const print = fingerprint().slice(0, 1) + fingerprint().slice(-1)
  const random = randomBlock().slice(-2)

  return date.slice(-2) + counter + print + random
}

/** Checks if a string is a valid CUID (starts with 'c') */
export const isCuid = (stringToCheck: string) => {
  if (typeof stringToCheck !== 'string') return false
  if (stringToCheck.startsWith('c') === true) return true
  return false
}

/** Checks if a string is a valid CUID slug (7-10 characters) */
export const isSlug = (stringToCheck: string) => {
  if (typeof stringToCheck !== 'string') return false
  const stringLength = stringToCheck.length
  if (stringLength >= 7 && stringLength <= 10) return true
  return false
}
