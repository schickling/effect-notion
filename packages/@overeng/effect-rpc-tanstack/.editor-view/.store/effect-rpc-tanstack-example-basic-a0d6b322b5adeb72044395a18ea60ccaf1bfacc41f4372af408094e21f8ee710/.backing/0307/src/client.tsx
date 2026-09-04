import { StartClient } from '@tanstack/react-start/client'
import { hydrateRoot } from 'react-dom/client'

import { getRouter } from './router.tsx'

const router = getRouter()

const App = StartClient as React.ComponentType<{ router: typeof router }>
hydrateRoot(document, <App router={router} />)
