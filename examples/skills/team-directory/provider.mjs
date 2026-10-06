import { readFile } from 'node:fs/promises'

export async function search({ query }) {
  const { endpoint } = JSON.parse(
    await readFile(new URL('./service.json', import.meta.url), 'utf8')
  )
  const url = new URL(endpoint)
  url.searchParams.set('q', query)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Directory service returned HTTP ${response.status}`)
  return response.json()
}
