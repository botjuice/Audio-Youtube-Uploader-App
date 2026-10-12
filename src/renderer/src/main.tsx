import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// The main process sets nativeTheme.themeSource from settings; the renderer just follows prefers-color-scheme.
const mq = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => document.documentElement.classList.toggle('dark', mq.matches)
applyTheme()
mq.addEventListener('change', applyTheme)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
