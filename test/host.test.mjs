/**
 * Host smoke tests for dsh-workspace-mover without the DSH runtime: a fake
 * workspace registry that mirrors the real seams (candidateMatches, raw
 * `record`, `mutate` pruning, attach cwd validation, `state.workspaceIds`
 * readiness), plus a fake web server.
 */
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// Canonical paths, as the real registry stores them (macOS /var is a symlink).
const work = await realpath(await mkdtemp(join(tmpdir(), 'wsm-test-')))
const cwdA = await realpath(await mkdir(join(work, 'project-a'), { recursive: true }) && join(work, 'project-a'))
const cwdB = await realpath(await mkdir(join(work, 'project-b'), { recursive: true }) && join(work, 'project-b'))
process.env.DSH_HOME = work
const storePath = join(work, 'storages', 'workspace-mover.json')

// ---- fake sessions ---------------------------------------------------------
const headers = new Map()
const addSession = (id, cwd, extra = {}) => headers.set(id, { id, cwd, createdAt: Date.now(), isSeeded: false, ...extra })

class FakeEntity {
  constructor(host, id, record) {
    this.host = host
    this.id = id
    this.record = record
  }

  get path() { return this.record.path }

  get title() { return this.record.title }

  get sessionIds() { return this.record.sessionIds.filter(id => this.host.candidateMatches(id, this.record.path)) }

  async attachSession(sessionId) {
    const header = this.host.readSessionHeader(sessionId)
    if (header?.cwd !== this.record.path) {
      throw new Error(`cannot attach session '${sessionId}': its cwd resolves to '${header?.cwd}'`)
    }
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? record
      : { ...record, sessionIds: [sessionId, ...record.sessionIds] })
  }

  async mutate(fn) {
    const current = this.record
    const next = fn(current)
    const pruned = next.sessionIds.filter(id => this.host.candidateMatches(id, next.path))
    if (next === current && pruned.length === current.sessionIds.length) return
    this.record = { ...next, sessionIds: pruned }
  }
}

/** Canonical cwd of a session as the workspace registry would index it. */
const canonical = (sessionId) => {
  const header = headers.get(sessionId)
  return header?.cwd !== undefined && header.cwd.startsWith(work) ? header.cwd : undefined
}

const { apply } = await import('../index.js')

/**
 * Build one scenario: a fresh registry object (its own `state` symbol, its own
 * host object and entities), a fake ctx, and `apply` already awaited.
 * @param {object} options - initial records, optional readiness/behaviour tweaks.
 */
const makeScenario = async (options = {}) => {
  const records = options.records ?? [
    { id: 'ws-a', path: cwdA, title: 'Project A', sessionIds: [] },
    { id: 'ws-b', path: cwdB, title: 'Project B', sessionIds: [] },
  ]
  const entities = new Map()
  const scenario = {
    entities,
    state: { workspaceIds: records.map(record => record.id) },
    sessionPaths: new Map(),
    missingSessionPaths: new Set(),
    host: {
      candidateMatches: (id, path) => scenario.sessionPaths.get(id) === path || scenario.missingSessionPaths.has(id),
      readSessionHeader: (id) => headers.get(id),
      rememberSessionPath: (id, path) => scenario.sessionPaths.set(id, path),
    },
    get(id) { return entities.get(id) },
    list() {
      if (this.state === undefined) throw new Error('workspace registry is not started yet')
      return this.state.workspaceIds.map(id => entities.get(id)).filter(Boolean)
    },
  }
  // One entity class per scenario, so each scenario has its own prototype to
  // patch — the real Host has one registry (and one prototype) per process.
  class ScenarioEntity extends FakeEntity {}
  for (const record of records) {
    entities.set(record.id, new ScenarioEntity(scenario.host, record.id, {
      path: record.path, title: record.title, sessionIds: [...record.sessionIds],
    }))
  }
  if (options.ready === false) {
    // Simulate a boot where [Service.init] has not published entities yet.
    scenario.state.workspaceIds = [...scenario.state.workspaceIds]
    entities.clear()
  }
  const ctx = {
    workspaceRegistry: scenario,
    logger: { info() {}, warn() {} },
    get() { return undefined },
    webServer: { register(route) { scenario.route = route; return () => {} } },
    connection: { requestRejection: () => options.fence?.() },
    effect(fn) { return fn() },
  }
  // The real registry indexes every stored header's canonical cwd during init;
  // the fake must do the same before apply() runs, or pruning drops members.
  for (const sessionId of headers.keys()) {
    const path = canonical(sessionId)
    if (path !== undefined) scenario.sessionPaths.set(sessionId, path)
  }
  scenario.ctx = ctx
  await apply(ctx)
  return scenario
}

const callOn = async (handler, method, path, body) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: path,
    headers: {},
    async* [Symbol.asyncIterator]() { yield* chunks },
    resume() {},
  }
  let statusCode = 0
  let payload = ''
  const res = {
    writeHead(status) { statusCode = status },
    end(data) { payload = data },
  }
  await handler(req, res)
  return { status: statusCode, body: JSON.parse(payload) }
}

const call = (scenario, method, path, body) => callOn(scenario.route.handler, method, path, body)

const movedCount = (scenario) => {
  const bySession = new Map()
  for (const workspace of scenario.list()) {
    for (const id of workspace.record.sessionIds) bySession.set(id, (bySession.get(id) ?? 0) + 1)
  }
  return bySession
}

// ---- P0-1: an unstarted registry must not prune the store ------------------
await mkdir(join(work, 'storages'), { recursive: true })
const seeded = { version: 1, moves: { 's-a1': { workspaceId: 'ws-b', cwd: cwdA } } }
await writeFile(storePath, JSON.stringify(seeded), 'utf8')
addSession('s-a1', cwdA)
addSession('s-a2', cwdA)
addSession('s-b1', cwdB)
await makeScenario({ ready: false, records: [
  { id: 'ws-a', path: cwdA, title: 'Project A', sessionIds: ['s-a2', 's-a1'] },
  { id: 'ws-b', path: cwdB, title: 'Project B', sessionIds: ['s-b1'] },
] })
assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).moves, seeded.moves, 'an unstarted registry must not clear the store')

// ---- reconcile: the mapping repairs a half-finished move -------------------
const scenario = await makeScenario({ records: [
  { id: 'ws-a', path: cwdA, title: 'Project A', sessionIds: ['s-a2', 's-a1'] },
  { id: 'ws-b', path: cwdB, title: 'Project B', sessionIds: ['s-b1'] },
] })
const a = scenario.get('ws-a')
const b = scenario.get('ws-b')
assert.deepEqual(a.record.sessionIds, ['s-a2'], 'reconcile removed the mapped session from its old workspace')
assert.deepEqual(b.record.sessionIds, ['s-a1', 's-b1'], 'reconcile put the mapped session at the head')

let state = await call(scenario, 'GET', '/workspace-mover/state')
assert.equal(state.status, 200)
assert.deepEqual(state.body.workspaces.find(workspace => workspace.id === 'ws-b').sessionIds, ['s-a1', 's-b1'])

// ---- move a2 into B, and survive a later write ----------------------------
const moved = await call(scenario, 'POST', '/workspace-mover/move', { sessionId: 's-a2', workspaceId: 'ws-b' })
assert.equal(moved.status, 200, JSON.stringify(moved.body))
assert.equal(moved.body.changed, true)
assert.equal(moved.body.previous.id, 'ws-a')
assert.equal(moved.body.workspace.id, 'ws-b')
assert.deepEqual(a.record.sessionIds, [])
assert.deepEqual(b.record.sessionIds, ['s-a2', 's-a1', 's-b1'])
await b.mutate(record => ({ ...record, title: 'B renamed' }))
assert.deepEqual(b.record.sessionIds, ['s-a2', 's-a1', 's-b1'])

// ---- forks of a moved session stay in that workspace ----------------------
addSession('s-fork', cwdA, { isSeeded: true })
await b.attachSession('s-fork')
assert.ok(b.record.sessionIds.includes('s-fork'))
addSession('s-fork2', join(work, 'gone-directory'), { isSeeded: true })
await b.attachSession('s-fork2')
assert.ok(b.record.sessionIds.includes('s-fork2'))
addSession('s-stranger', join(work, 'elsewhere'))
await assert.rejects(() => b.attachSession('s-stranger'), /its cwd resolves to/)

// ---- P0-2: concurrent moves leave exactly one account ---------------------
const [first, second] = await Promise.all([
  call(scenario, 'POST', '/workspace-mover/move', { sessionId: 's-a1', workspaceId: 'ws-a' }),
  call(scenario, 'POST', '/workspace-mover/move', { sessionId: 's-a1', workspaceId: 'ws-b' }),
])
assert.equal(first.status, 200, JSON.stringify(first.body))
assert.equal(second.status, 200, JSON.stringify(second.body))
assert.equal(movedCount(scenario).get('s-a1'), 1, 'a session must be accounted by at most one workspace')
assert.equal(
  JSON.parse(await readFile(storePath, 'utf8')).moves['s-a1'],
  b.record.sessionIds.includes('s-a1') ? 'ws-b' : 'ws-a',
  'the store agrees with the record that actually holds it',
)

// ---- moving out to Ungrouped ----------------------------------------------
const out = await call(scenario, 'POST', '/workspace-mover/move', { sessionId: 's-a1', workspaceId: null })
assert.equal(out.status, 200)
assert.equal(out.body.workspace, null)
assert.equal(movedCount(scenario).get('s-a1'), undefined)
assert.equal(JSON.parse(await readFile(storePath, 'utf8')).moves['s-a1'], undefined)

// ---- no-op and error surfaces ---------------------------------------------
const same = await call(scenario, 'POST', '/workspace-mover/move', { sessionId: 's-b1', workspaceId: 'ws-b' })
assert.equal(same.body.changed, false)
const badSession = await call(scenario, 'POST', '/workspace-mover/move', { sessionId: 'nope', workspaceId: 'ws-b' })
assert.equal(badSession.status, 404)
assert.equal(badSession.body.code, 'session-not-found')
const badTarget = await call(scenario, 'POST', '/workspace-mover/move', { sessionId: 's-b1', workspaceId: 'ws-missing' })
assert.equal(badTarget.status, 404)
assert.equal(badTarget.body.code, 'workspace-not-found')
const badBody = await call(scenario, 'POST', '/workspace-mover/move', { sessionId: 's-b1' })
assert.equal(badBody.status, 400)
const wrongMethod = await call(scenario, 'POST', '/workspace-mover/state')
assert.equal(wrongMethod.status, 405)

// ---- fence: a rejected request changes nothing ----------------------------
const fenced = await makeScenario({
  fence: () => 403,
  records: [
    { id: 'ws-a', path: cwdA, title: 'Project A', sessionIds: [] },
    { id: 'ws-b', path: cwdB, title: 'Project B', sessionIds: ['s-b1'] },
  ],
})
const rejected = await call(fenced, 'POST', '/workspace-mover/move', { sessionId: 's-b1', workspaceId: 'ws-a' })
assert.equal(rejected.status, 403)
assert.ok(fenced.get('ws-b').record.sessionIds.includes('s-b1'), 'a rejected request changes nothing')
assert.ok(!fenced.get('ws-a').record.sessionIds.includes('s-b1'))

// ---- P0-3: an unwritable store fails the move instead of half-applying it --
await rename(storePath, `${storePath}.keep`)
await mkdir(storePath) // a directory where the store file belongs: writes now fail
const brokenMove = await call(scenario, 'POST', '/workspace-mover/move', { sessionId: 's-b1', workspaceId: 'ws-a' })
assert.equal(brokenMove.status, 500)
assert.equal(brokenMove.body.code, 'record-write-failed')
assert.ok(b.record.sessionIds.includes('s-b1'), 'the record must not change when the map cannot be saved')
assert.ok(!a.record.sessionIds.includes('s-b1'))
await rm(storePath, { recursive: true, force: true })
await rename(`${storePath}.keep`, storePath)

// ---- 409: a target that does not actually keep the member ------------------
const nativeMutate = a.mutate
a.mutate = async () => {}
const notAttached = await call(scenario, 'POST', '/workspace-mover/move', { sessionId: 's-b1', workspaceId: 'ws-a' })
a.mutate = nativeMutate
assert.equal(notAttached.status, 409)
assert.equal(notAttached.body.code, 'not-attached')
assert.ok(!a.record.sessionIds.includes('s-b1'), 'a failed insert is not recorded as a move')
assert.equal(movedCount(scenario).get('s-b1'), 1, 'and it is never duplicated')

// ---- a deleted target workspace drops its mappings ------------------------
await call(scenario, 'POST', '/workspace-mover/move', { sessionId: 's-b1', workspaceId: 'ws-a' })
assert.ok(a.record.sessionIds.includes('s-b1'))
scenario.state.workspaceIds = scenario.state.workspaceIds.filter(id => id !== 'ws-a')
scenario.entities.delete('ws-a')
state = await call(scenario, 'GET', '/workspace-mover/state')
assert.equal(state.body.moves['s-b1'], undefined, 'a mapping to a deleted workspace is dropped')
assert.equal(state.body.moves['s-a2'], 'ws-b', 'mappings to live workspaces survive')

// ---- N1: a plugin reload must not open a second mutation chain -------------
const reloaded = await makeScenario({ records: [
  { id: 'ws-a', path: cwdA, title: 'Project A', sessionIds: ['s-a2'] },
  { id: 'ws-b', path: cwdB, title: 'Project B', sessionIds: ['s-b1'] },
] })
const previousRoute = reloaded.route
await apply(reloaded.ctx) // second module generation over the same registry
assert.notEqual(reloaded.route, previousRoute, 'the reload registered a fresh route')
const [genOne, genTwo] = await Promise.all([
  callOn(previousRoute.handler, 'POST', '/workspace-mover/move', { sessionId: 's-a2', workspaceId: 'ws-b' }),
  callOn(reloaded.route.handler, 'POST', '/workspace-mover/move', { sessionId: 's-a2', workspaceId: 'ws-a' }),
])
assert.equal(genOne.status, 200, JSON.stringify(genOne.body))
assert.equal(genTwo.status, 200, JSON.stringify(genTwo.body))
assert.equal(movedCount(reloaded).get('s-a2'), 1, 'both generations share one mutation chain')

// ---- N2: a failed save when moving out keeps the session in place ---------
await rename(storePath, `${storePath}.keep2`)
await mkdir(storePath)
const outFailed = await call(reloaded, 'POST', '/workspace-mover/move', { sessionId: 's-b1', workspaceId: null })
assert.equal(outFailed.status, 500)
assert.equal(outFailed.body.code, 'record-write-failed')
assert.ok(reloaded.get('ws-b').record.sessionIds.includes('s-b1'), 'the session stays where it was')
await rm(storePath, { recursive: true, force: true })
await rename(`${storePath}.keep2`, storePath)

// ---- N5: a fork that the native check accepts needs no mapping -------------
await writeFile(storePath, JSON.stringify({ version: 1, moves: { 's-a1': 'ws-a' } }), 'utf8')
addSession('s-native', cwdA)
addSession('s-native-fork', cwdA, { isSeeded: true })
const nativeFork = await makeScenario({ records: [
  { id: 'ws-a', path: cwdA, title: 'Project A', sessionIds: ['s-a1'] },
  { id: 'ws-b', path: cwdB, title: 'Project B', sessionIds: [] },
] })
const before = JSON.parse(await readFile(storePath, 'utf8'))
await nativeFork.get('ws-a').attachSession('s-native-fork')
const after = JSON.parse(await readFile(storePath, 'utf8'))
assert.ok(nativeFork.get('ws-a').record.sessionIds.includes('s-native-fork'))
assert.deepEqual(after.moves, before.moves, 'a natively-attachable fork is not added to the map')

// ---- a same-directory move needs no mapping -------------------------------
await writeFile(storePath, JSON.stringify({ version: 1, moves: {} }), 'utf8')
addSession('s-same-dir', cwdA)
const sameDir = await makeScenario({ records: [
  { id: 'ws-a', path: cwdA, title: 'Project A', sessionIds: [] },
  { id: 'ws-b', path: cwdB, title: 'Project B', sessionIds: [] },
] })
const intoOwnDir = await call(sameDir, 'POST', '/workspace-mover/move', { sessionId: 's-same-dir', workspaceId: 'ws-a' })
assert.equal(intoOwnDir.status, 200, JSON.stringify(intoOwnDir.body))
assert.equal(intoOwnDir.body.changed, true)
assert.ok(sameDir.get('ws-a').record.sessionIds.includes('s-same-dir'))
assert.deepEqual(
  JSON.parse(await readFile(storePath, 'utf8')).moves,
  {},
  'a session whose cwd is the workspace path needs no reassignment record',
)

// ... and it survives a restart on the native check alone
const restarted = await makeScenario({ records: [
  { id: 'ws-a', path: cwdA, title: 'Project A', sessionIds: ['s-same-dir'] },
  { id: 'ws-b', path: cwdB, title: 'Project B', sessionIds: [] },
] })
assert.deepEqual(restarted.get('ws-a').record.sessionIds, ['s-same-dir'])
assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).moves, {})

// ---- a redundant mapping is pruned at boot -------------------------------
await writeFile(storePath, JSON.stringify({ version: 1, moves: { 's-same-dir': 'ws-a' } }), 'utf8')
const prunedBoot = await makeScenario({ records: [
  { id: 'ws-a', path: cwdA, title: 'Project A', sessionIds: ['s-same-dir'] },
  { id: 'ws-b', path: cwdB, title: 'Project B', sessionIds: [] },
] })
assert.deepEqual(prunedBoot.get('ws-a').record.sessionIds, ['s-same-dir'], 'the record still holds it')
assert.deepEqual(
  JSON.parse(await readFile(storePath, 'utf8')).moves,
  {},
  'a mapping the native cwd check already covers is pruned',
)

await rm(work, { recursive: true, force: true })
console.log('host smoke test passed')
