#!/usr/bin/env node
/**
 * A server version must identify the files its agents will download from that
 * tag. Deploying a different tree under an old version makes every sync stale.
 * Untagged release commits may deploy before their tag is published.
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const compare = (a, b) => {
  const left = a.split('.').map(BigInt)
  const right = b.split('.').map(BigInt)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  }
  return 0
}

export function decideDeployVersion({ version, tags, treeEqual, commitsPast, headSha, tagSha }) {
  const refuse = (message) => ({ allowed: false, message })
  if (!VERSION.test(version)) return refuse(`Cairn deploy refused: invalid package.json version ${version}`)
  const versions = tags.filter((tag) => tag.startsWith('v') && VERSION.test(tag.slice(1)))
    .map((tag) => tag.slice(1)).sort(compare)
  const newest = versions.at(-1)
  if (!newest) return refuse('Cairn deploy refused: no release tags found; fetch tags: fetch-depth 0')

  const tag = `v${version}`
  const nextBase = compare(version, newest) > 0 ? version : newest
  const [major, minor, patch] = nextBase.split('.')
  const next = `${major}.${minor}.${BigInt(patch) + 1n}`
  const remedy = `Cut the next release: drove release ${next} --prepare (in a Drove run), ` +
    `or node scripts/release.mjs ${next} --confirm; then publish it.`
  const head = `HEAD ${headSha?.slice(0, 7) ?? 'unknown'} (version ${version})`
  if (tags.includes(tag) && !treeEqual) {
    return refuse(`Cairn deploy refused: ${head} differs from ${tag} (${tagSha?.slice(0, 7) ?? 'unknown'}), ` +
      `${commitsPast} commits past ${tag}. ${remedy}`)
  }
  if (compare(version, newest) < 0) {
    return refuse(`Cairn deploy refused: ${head} is lower than newest tag v${newest}. ${remedy}`)
  }
  return { allowed: true, message: `Cairn deploy allowed: ${head}; ${tags.includes(tag) ? `same tree as ${tag}` : `${tag} is not tagged yet`}` }
}

function main() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    if (git('rev-parse', '--is-inside-work-tree') !== 'true') throw new Error('not a git checkout')
    if (git('rev-parse', '--is-shallow-repository') !== 'false') throw new Error('shallow git checkout')
    const version = JSON.parse(git('show', 'HEAD:package.json')).version
    const tags = git('tag', '--list').split('\n').filter(Boolean)
    const headSha = git('rev-parse', 'HEAD')
    const tag = `v${version}`
    let treeEqual = false
    let tagSha
    let commitsPast
    if (tags.includes(tag)) {
      tagSha = git('rev-parse', `${tag}^{commit}`)
      commitsPast = Number(git('rev-list', '--count', `${tag}..HEAD`))
      try {
        git('diff', '--quiet', tag, 'HEAD')
        treeEqual = true
      } catch (error) {
        if (error.status !== 1) throw error
      }
    }
    const result = decideDeployVersion({ version, tags, treeEqual, commitsPast, headSha, tagSha })
    if (result.allowed) process.stdout.write(`${result.message}\n`)
    else {
      process.stderr.write(`${result.message}\n`)
      process.exitCode = 1
    }
  } catch (error) {
    process.stderr.write(`Cairn deploy refused: ${error.message}; fetch tags: fetch-depth 0\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
