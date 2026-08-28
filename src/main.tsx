import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import OnlineGate from './online/OnlineGate.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OnlineGate />
  </StrictMode>,
)
