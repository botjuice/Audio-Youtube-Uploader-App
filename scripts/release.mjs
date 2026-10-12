#!/usr/bin/env node
// Usage: npm run release -- patch | minor | major | 2.3.4
// Bumps package.json, runs checks, commits, tags vX.Y.Z, pushes branch + tag → GitHub Actions builds installers.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const sh = (c) => execSync(c, { stdio: 'pipe', encoding: 'utf8' }).trim()
const run = (c) => execSync(c, { stdio: 'inherit' })

if (sh('git status --porcelain')) { console.error('✗ Working tree not clean — commit or stash first.'); process.exit(1) }

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [maj, min, pat] = pkg.version.split('.').map(Number)
const arg = process.argv[2] ?? 'patch'
const next = /^\d+\.\d+\.\d+$/.test(arg) ? arg
  : arg === 'major' ? `${maj + 1}.0.0` : arg === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`

console.log(`\n▶ ${pkg.version} → ${next}\n`)
run('npm run -s typecheck'); run('npx vitest run --reporter=dot')

pkg.version = next
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
try { run('npm install --package-lock-only --ignore-scripts >/dev/null 2>&1') } catch {}

const upstream = sh('git rev-parse --abbrev-ref --symbolic-full-name @{u}') // e.g. origin/v2
const [remote, ...rest] = upstream.split('/'); const branch = rest.join('/')
run('git add package.json package-lock.json')
run(`git commit -q -m "Release v${next}"`)
run(`git tag v${next}`)
run(`git push ${remote} HEAD:${branch}`)
run(`git push ${remote} v${next}`)

const repo = sh(`git remote get-url ${remote}`).replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/')
console.log(`\n✓ Tagged v${next}. Installers will appear at ${repo}/releases/tag/v${next} in ~6 minutes.`)
console.log(`  Watch: ${repo}/actions\n`)
