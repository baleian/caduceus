import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { applyTheme, loadPrefs } from './state/prefs'
import './index.css'

applyTheme(loadPrefs()) // before first paint (Q5=A)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
