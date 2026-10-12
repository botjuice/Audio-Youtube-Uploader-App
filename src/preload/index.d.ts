import type { Api } from '../shared/api'
declare global {
  interface Window { api: Api; platform: NodeJS.Platform }
}
export {}
