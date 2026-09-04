import { createFileRoute, type FileRoutesByPath } from '@tanstack/react-router'

import { makeHandler } from '@overeng/effect-rpc-tanstack/server'

import { UserApi } from '../../rpc/api.ts'
import { UserHandlers } from '../../rpc/server.ts'

const { handler } = makeHandler({ group: UserApi, handlerLayer: UserHandlers })

/** RPC API route handler - path cast needed until route tree is regenerated */
export const Route = createFileRoute('/api/rpc' as keyof FileRoutesByPath)({
  server: {
    handlers: {
      POST: ({ request }) => handler(request),
    },
  },
})
