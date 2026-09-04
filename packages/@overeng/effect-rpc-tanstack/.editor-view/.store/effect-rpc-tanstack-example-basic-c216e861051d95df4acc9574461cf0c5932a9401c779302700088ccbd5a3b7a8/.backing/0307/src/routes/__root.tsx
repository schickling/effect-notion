import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'

const RootComponent = () => (
  <html lang="en">
    <head>
      <HeadContent />
    </head>
    <body>
      <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
        <h1>Effect RPC + TanStack Start</h1>
        <Outlet />
      </div>
      <Scripts />
    </body>
  </html>
)

/** Root route configuration */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Effect RPC + TanStack Start Example' },
    ],
  }),
  component: RootComponent,
})
