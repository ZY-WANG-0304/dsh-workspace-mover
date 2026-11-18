/**
 * Client smoke test for dsh-workspace-mover without a browser: a stub module
 * loader, a stub React, a fake DOM tree that mirrors the sidebar's
 * `data-row-key` markers, and a fake fetch for the Host routes.
 */
import assert from 'node:assert/strict'

// ---- fake React ------------------------------------------------------------
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (subscribe, snapshot) => {
    subscribe(() => {})
    return snapshot()
  },
}

// ---- fake DOM --------------------------------------------------------------
class El {
  constructor(tag, attrs = {}) {
    this.tag = tag
    this.attrs = attrs
    this.children = []
    this.parentElement = null
  }

  get firstElementChild() { return this.children[0] ?? null }

  getAttribute(name) { return this.attrs[name] ?? null }

  closest(selector) {
    assert.equal(selector, '[data-row-key]')
    let node = this
    while (node) {
      if (node.attrs?.['data-row-key'] !== undefined) return node
      node = node.parentElement
    }
    return null
  }

  append(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }
}

const documentListeners = new Map()
const fire = (type, event) => {
  for (const listener of documentListeners.get(type) ?? []) listener(event)
}
const document = {
  baseURI: 'http://127.0.0.1:62000/',
  addEventListener(type, listener) {
    const list = documentListeners.get(type) ?? []
    list.push(listener)
    documentListeners.set(type, list)
  },
  removeEventListener(type, listener) {
    documentListeners.set(type, (documentListeners.get(type) ?? []).filter(l => l !== listener))
  },
}

// ---- fake host -------------------------------------------------------------
const workspaces = [
  { id: 'ws-a', title: 'Project A', path: '/work/a', sessionIds: ['s-1', 's-2'] },
  { id: 'ws-b', title: 'Project B', path: '/work/b', sessionIds: ['s-3'] },
]
const moves = {}
const calls = []
let deferState = false
const deferredStates = []
const fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init })
  if (deferState && String(url).endsWith('/state')) {
    await new Promise(resolve => deferredStates.push(resolve))
  }
  if (String(url).endsWith('/state')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, workspaces: workspaces.map(w => ({ ...w })), moves: { ...moves } }) }
  }
  if (String(url).endsWith('/move')) {
    const body = JSON.parse(init.body)
    const target = body.workspaceId === null ? null : workspaces.find(w => w.id === body.workspaceId)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        changed: true,
        workspaceId: body.workspaceId,
        workspace: target === null ? null : { id: target.id, title: target.title, path: target.path },
        previous: { id: 'ws-a', title: 'Project A', path: '/work/a' },
      }),
    }
  }
  throw new Error(`unexpected fetch ${url}`)
}

// ---- stub loader -----------------------------------------------------------
let module_ = null
const windowListeners = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      assert.equal(spec.id, 'dsh-workspace-mover')
      module_ = spec.factory(name => {
        assert.equal(name, 'react')
        return React
      })
    },
  },
  addEventListener(type, listener) {
    const list = windowListeners.get(type) ?? []
    list.push(listener)
    windowListeners.set(type, list)
  },
  removeEventListener(type, listener) {
    windowListeners.set(type, (windowListeners.get(type) ?? []).filter(entry => entry !== listener))
  },
}
const fireWindow = (type, event = {}) => {
  for (const listener of windowListeners.get(type) ?? []) listener(event)
}
globalThis.document = document
globalThis.fetch = fetch
globalThis.setTimeout = globalThis.setTimeout

await import('../client.js')
assert.ok(module_ !== null, 'client module registered')
assert.deepEqual(module_.inject, ['slots'])

// ---- fake client ctx -------------------------------------------------------
const registrations = []
const dictionaries = []
const effects = []
const locale = {
  register(ns, tag, dict) { dictionaries.push([ns, tag, dict]); return () => {} },
  bind() { return (key, params) => (params === undefined ? `t:${key}` : `t:${key}(${JSON.stringify(params)})`) },
}
const ctx = {
  get(name) { return name === 'locale' ? locale : undefined },
  slots: {
    inject(owner, callback) { registrations.push({ owner, register: callback }); return () => {} },
    register(options, component) { return { options, component } },
  },
  effect(fn, label) { effects.push(label); return fn() },
}

const result = module_.apply(ctx)
assert.equal(result, undefined)
// The bridge warms its catalog at activation; let that first read settle.
await new Promise(resolve => setTimeout(resolve, 0))

// locale dictionaries for both baselines
assert.deepEqual(dictionaries.map(entry => entry[1]), ['zh', 'en'])
assert.ok(dictionaries[0][2]['menu.move'].length > 0)

// slot registrations
const owners = registrations.map(entry => entry.owner)
assert.deepEqual(owners, ['sidebar.workspaces.session.menu.item', 'shell.overlay'])
const menuRegistration = registrations[0].register()
const overlayRegistration = registrations[1].register()
assert.equal(menuRegistration.options.id, 'workspace-mover.move')
assert.equal(overlayRegistration.options.id, 'workspace-mover.overlay')

// ---- sidebar fixture -------------------------------------------------------
// Drop targets resolve through the catalog (workspace headers name their group,
// session rows resolve through their account), so the fixture only needs the
// marked rows the browser actually renders — no assumption about how a group
// section nests its header.
const rowOfSession = (sessionId) => new El('div', { 'data-row-key': `session:${sessionId}` })
const rowOfWorkspace = (groupKey) => new El('div', { 'data-row-key': `workspace:${groupKey}` })
const groupA = { rows: new Map([['s-1', rowOfSession('s-1')], ['s-2', rowOfSession('s-2')]]) }
const groupB = { rows: new Map([['s-3', rowOfSession('s-3')]]) }
const ungrouped = { rows: new Map([['s-9', rowOfSession('s-9')]]), header: rowOfWorkspace('') }

// ---- menu item -------------------------------------------------------------
/** Depth-first walk over a React element tree, visiting every element. */
const walk = (node, visit) => {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object' || node.props === undefined) return
  visit(node)
  walk(node.children, visit)
}
/** Every element in the tree, depth first. */
const elements = (tree) => {
  const found = []
  walk(tree, node => found.push(node))
  return found
}
const byClass = (tree, className) => elements(tree).find(node => typeof node.props.className === 'string' && node.props.className.split(' ').includes(className))
const byRole = (tree, role) => elements(tree).find(node => node.props.role === role)
/** Instantiate one composed component element to inspect what it renders. */
const renderComponent = (element) => element.type(element.props)

const menuComponent = menuRegistration.component
let menuClosed = false
const menu = menuComponent({
  sessionId: 's-1',
  displayTitle: 'Session one',
  useMenuOpenState: () => [true, (open) => { if (!open) menuClosed = true }],
})
assert.ok(byClass(menu, 'wsm-menuItem'), 'menu entry uses the Menu item recipe class')
const menuButton = byRole(menu, 'menuitem')
assert.equal(menuButton.props.type, 'button')
assert.deepEqual(byClass(menu, 'wsm-menuLabel').children, ['t:menu.move'])
assert.ok(byClass(menu, 'wsm-menuIcon') !== undefined, 'menu entry carries the item icon seat')

// clicking opens the picker and dismisses the menu
menuButton.props.onClick()
assert.equal(menuClosed, true)
await new Promise(resolve => setTimeout(resolve, 0))
assert.deepEqual(calls.at(-1).url, 'http://127.0.0.1:62000/workspace-mover/state')

// ---- overlay renders the dialog -------------------------------------------
const overlayComponent = overlayRegistration.component
/** Render the overlay and return the composed dialog element, when one is open. */
const renderOverlay = () => {
  const tree = overlayComponent({})
  const composed = elements(tree)
    .filter(node => typeof node.type === 'function')
    .map(node => node.type(node.props))
  return { tree, dialogElement: composed.find(node => byClass(node, 'wsm-dialog') !== undefined) }
}

let overlay = overlayComponent({})
let rendered = renderOverlay()
assert.ok(rendered.dialogElement !== undefined, 'dialog composed after the menu click')
let dialogNode = byClass(rendered.dialogElement, 'wsm-dialog')
assert.ok(dialogNode !== undefined, 'dialog visible after menu click')
assert.equal(dialogNode.props.role, 'dialog')

// the card is the Modal recipe: l2 surface, panel radius, prominent elevation
assert.match(String(byClass(rendered.dialogElement, 'wsm-mask') !== undefined), /true/)
assert.ok(byClass(rendered.dialogElement, 'wsm-header') !== undefined)
assert.match(String(dialogNode.props.className), /wsm-dialog/)

// one row per workspace, plus the leave-workspace row after a separator
const rows = elements(dialogNode).filter(node => node?.props?.label !== undefined)
assert.equal(rows.length, 3, 'one choice per workspace plus the leave-workspace entry')
assert.equal(rows[0].props.label, 'Project A')
assert.equal(rows[0].props.current, true, 'the current workspace is marked')
assert.equal(rows[2].props.label, 't:dialog.ungrouped')
assert.ok(byClass(dialogNode, 'wsm-separator') !== undefined, 'leave-workspace row is separated')
assert.ok(byClass(dialogNode, 'wsm-buttonOutline') !== undefined, 'footer uses the outline Button recipe')

// the row renders the title/path pair of the dialog list, plus the check marker
const firstRow = renderComponent(rows[0])
assert.deepEqual(byClass(firstRow, 'wsm-rowTitle').children, ['Project A'])
assert.deepEqual(byClass(firstRow, 'wsm-rowPath').children, ['/work/a'])
assert.equal(firstRow.props['aria-current'], 'true')
assert.ok(byClass(firstRow, 'wsm-check') !== undefined, 'the row that already holds the session carries the check')

// picking the current workspace closes without a request
const callsBefore = calls.length
rows[0].props.onPick()
assert.equal(calls.length, callsBefore, 'the current workspace is not a move target')

// clicking the second row posts the move and closes the dialog
rows[1].props.onPick()
await new Promise(resolve => setTimeout(resolve, 0))
const post = calls.at(-1)
assert.equal(post.url, 'http://127.0.0.1:62000/workspace-mover/move')
assert.equal(post.init.method, 'POST')
assert.deepEqual(JSON.parse(post.init.body), { sessionId: 's-1', workspaceId: 'ws-b' })

assert.equal(renderOverlay().dialogElement, undefined, 'dialog closed after moving')

// ---- drag bridge ----------------------------------------------------------
assert.ok(effects.includes('workspace-mover: drag bridge'))
assert.ok(documentListeners.get('dragstart')?.length === 1)

const dragEvent = (target, extra = {}) => ({
  target,
  dataTransfer: { dropEffect: 'none', types: ['text/plain'] },
  clientX: 40,
  clientY: 60,
  defaultPrevented: false,
  stopped: false,
  preventDefault() { this.defaultPrevented = true },
  stopPropagation() { this.stopped = true },
  ...extra,
})

// same-group drag: the built-in reorder must stay in charge
fire('dragstart', dragEvent(groupA.rows.get('s-1')))
const sameGroup = dragEvent(groupA.rows.get('s-2'))
fire('dragover', sameGroup)
assert.equal(sameGroup.defaultPrevented, false, 'same-group hover is left to the built-in reorder')

// cross-group drag: intercepted, ghost shown
const acrossGroup = dragEvent(groupB.rows.get('s-3'))
fire('dragover', acrossGroup)
assert.equal(acrossGroup.preventDefault, acrossGroup.preventDefault)
assert.equal(acrossGroup.defaultPrevented, true, 'cross-group hover is claimed')
assert.equal(acrossGroup.stopped, true)
assert.equal(acrossGroup.dataTransfer.dropEffect, 'move')
assert.equal(calls.at(-1).url, 'http://127.0.0.1:62000/workspace-mover/state')

overlay = overlayComponent({})
const ghost = byClass(overlay, 'wsm-ghost')
assert.ok(ghost !== undefined, 'drag chip rendered with the Tooltip recipe')
assert.match(String(ghost.children.join('')), /t:drop\.into/)

// dropping there performs the move
const drop = dragEvent(groupB.rows.get('s-3'))
fire('drop', drop)
assert.equal(drop.defaultPrevented, true)
await new Promise(resolve => setTimeout(resolve, 0))
assert.deepEqual(JSON.parse(calls.at(-1).init.body), { sessionId: 's-1', workspaceId: 'ws-b' })

// dropping on the Ungrouped group header detaches; an unaccounted session row
// inside it names no target (it must not be read as "move to Ungrouped")
fire('dragstart', dragEvent(groupB.rows.get('s-3')))
const ambiguousDrop = dragEvent(ungrouped.rows.get('s-9'))
const postsBeforeAmbiguous = calls.filter(call => call.url.endsWith('/move')).length
fire('dragover', ambiguousDrop)
assert.equal(ambiguousDrop.defaultPrevented, false, 'an unaccounted session row is not a drop target')
fire('drop', ambiguousDrop)
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(calls.filter(call => call.url.endsWith('/move')).length, postsBeforeAmbiguous)

fire('dragstart', dragEvent(groupB.rows.get('s-3')))
const dropUngrouped = dragEvent(ungrouped.header)
fire('drop', dropUngrouped)
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(dropUngrouped.defaultPrevented, true, 'the Ungrouped header is the detach target')
assert.deepEqual(JSON.parse(calls.at(-1).init.body), { sessionId: 's-3', workspaceId: null })

// a file drag (no session row) is ignored
fire('dragstart', dragEvent(new El('div')))
const fileHover = dragEvent(groupB.rows.get('s-3'))
fire('dragover', fileHover)
assert.equal(fileHover.defaultPrevented, false)

// ---- P1-8: an outside drag is never a session move ------------------------
const postCount = () => calls.filter(call => call.url.endsWith('/move')).length
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const postsBefore = postCount()

fire('dragstart', dragEvent(groupA.rows.get('s-1')))
const outsideDrop = dragEvent(groupB.rows.get('s-3'), { dataTransfer: { dropEffect: 'none', types: ['Files'] } })
fire('dragover', outsideDrop)
assert.equal(outsideDrop.defaultPrevented, false, 'a file drag is not claimed')
fire('drop', outsideDrop)
await tick()
assert.equal(postCount(), postsBefore, 'a file drag never moves a session')

// a session drag whose source row vanished mid-drag must not claim a later drop
fire('dragstart', dragEvent(groupA.rows.get('s-1')))
fireWindow('blur')
const staleDrop = dragEvent(groupB.rows.get('s-3'))
fire('drop', staleDrop)
await tick()
assert.equal(staleDrop.defaultPrevented, false, 'a cancelled drag stops claiming drops')
assert.equal(postCount(), postsBefore, 'a cancelled drag never moves a session')

// ---- P1-9: a workspace header row is a valid target by itself -------------
fire('dragstart', dragEvent(groupA.rows.get('s-1')))
const headerDrop = dragEvent(ungrouped.header)
fire('dragover', headerDrop)
assert.equal(headerDrop.defaultPrevented, true, 'the Ungrouped header accepts a drag')
fire('drop', headerDrop)
await tick()
assert.deepEqual(JSON.parse(calls.at(-1).init.body), { sessionId: 's-1', workspaceId: null })

// ---- P1-10: closing the picker while it loads keeps it closed -------------
deferState = true
menuButton.props.onClick()
await tick()
let pending = renderOverlay()
assert.ok(pending.dialogElement !== undefined, 'the picker shows its loading state')
byClass(pending.dialogElement, 'wsm-mask').props.onClick()
assert.equal(renderOverlay().dialogElement, undefined, 'the mask closes the picker')
deferState = false
deferredStates.shift()()
await tick()
await tick()
assert.equal(renderOverlay().dialogElement, undefined, 'a late catalog read does not reopen it')

console.log('client smoke test passed')
