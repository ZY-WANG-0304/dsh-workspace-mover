/**
 * Client half of dsh-workspace-mover: move a Session into another Workspace
 * from the Session row menu, or by dragging its row onto another Workspace's
 * group in the sidebar.
 *
 * The sidebar is the built-in Workspace browser; a plugin cannot add drop
 * targets to its rows. This half therefore listens in the capture phase for the
 * browser's own HTML5 drag of a Session row, and only intervenes when the drop
 * target resolves to a *different* group: same-group drops stay with the
 * built-in reorder behaviour, and workspace-row drags, file drags and flat-list
 * drops are ignored. Group identity comes from the browser's public
 * `data-row-key` markers (`session:<id>`, `workspace:<groupId>`), never from
 * its hashed class names.
 *
 * The surface follows the host's design system by reusing its tokens and its
 * published metrics: the popover row is the Menu item recipe (13/20, min-height
 * 34, padding 6×8, radius-md, `--dsw-alias-interactive-bg-hover`), the card is
 * the Modal recipe (`bg-layer-2`, `radius-panel`, `elevation-prominent`, mask
 * with `--dsw-mask-blur` and `bg-mask-1`, 16/24 title), the footer button is the
 * outline Button recipe, the notice is the shared Toast recipe and the drag
 * chip is the Tooltip recipe. Primitives cannot be imported from a plugin, so
 * the rules are copied from the shipped stylesheets rather than re-imagined.
 *
 * All writes go through the Host half's `/workspace-mover/move` route; the
 * sidebar then repaints from DSH's own `workspace/follow` stream.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-mover',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this module owns. */
    const NS = 'workspace-mover'

    /** Host route prefix, resolved against the page base (works in the desktop shell too). */
    const ROUTE = 'workspace-mover'

    const ZH = {
      'menu.move': '移动到工作区',
      'menu.ungrouped': '未分组',
      'dialog.title': '移动会话到工作区',
      'dialog.close': '关闭',
      'dialog.desc': '将把会话“{name}”移动到所选工作区；日志、文件与运行中的工作都会保留。',
      'dialog.descUntitled': '将把这个会话移动到所选工作区；日志、文件与运行中的工作都会保留。',
      'dialog.ungrouped': '移出工作区（未分组）',
      'dialog.empty': '请先在侧栏添加一个工作区',
      'dialog.loading': '正在加载工作区…',
      'dialog.cancel': '取消',
      'dialog.failed': '无法读取工作区列表：{reason}',
      'drop.into': '松开移动到“{name}”',
      'drop.ungrouped': '松开移出工作区',
      'toast.moved': '已移动到“{name}”',
      'toast.removed': '已移出工作区',
      'toast.failed': '移动失败：{reason}',
      'toast.same': '会话已在该工作区中',
    }
    const EN = {
      'menu.move': 'Move to workspace',
      'menu.ungrouped': 'Ungrouped',
      'dialog.title': 'Move session to a workspace',
      'dialog.close': 'Close',
      'dialog.desc': 'This moves “{name}” into the workspace you pick. The log, its files and any running work stay as they are.',
      'dialog.descUntitled': 'This moves this session into the workspace you pick. The log, its files and any running work stay as they are.',
      'dialog.ungrouped': 'Leave every workspace (Ungrouped)',
      'dialog.empty': 'Add a workspace in the sidebar first',
      'dialog.loading': 'Loading workspaces…',
      'dialog.cancel': 'Cancel',
      'dialog.failed': 'Could not read the workspace list: {reason}',
      'drop.into': 'Drop to move into “{name}”',
      'drop.ungrouped': 'Drop to leave the workspace',
      'toast.moved': 'Moved to “{name}”',
      'toast.removed': 'Left the workspace',
      'toast.failed': 'Move failed: {reason}',
      'toast.same': 'The session is already in that workspace',
    }

    // ---- design-system surface --------------------------------------------
    /**
     * Component-local styles. The app cannot be asked for its primitives from a
     * plugin, so each rule below restates the published host recipe: Menu items
     * (`_item_70kcw_173`), Modal (`_dialog_1ytzq_33`), Button (`_button_1ulci_2`),
     * Toast (`_toast_af3m1_6`) and Tooltip (`_bubble_gm1ra_1`) — same tokens,
     * same metrics, same interaction states.
     */
    const STYLES = `
.wsm-menuItem{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}
.wsm-menuItem:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}
.wsm-menuIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon)}
.wsm-menuIcon svg{width:14px;height:14px}
.wsm-menuLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wsm-overlay{position:fixed;inset:0;z-index:1000;pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.wsm-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0) 0 0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.wsm-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:0;width:min(380px,100%);max-height:min(600px,calc(100dvh - 48px));padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent);font-family:inherit;-webkit-app-region:no-drag;animation:wsm-enter var(--ds-transition-duration) var(--ds-ease-in-out);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.wsm-dialog:focus{outline:none}
@keyframes wsm-enter{from{opacity:0}to{opacity:1}}
.wsm-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.wsm-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.wsm-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.wsm-close svg{width:16px;height:16px}
.wsm-desc{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary)}
.wsm-body{display:flex;flex-direction:column;gap:2px;min-height:0;margin-top:20px;padding:0 24px;overflow-y:auto;overscroll-behavior:contain}
.wsm-note{margin:0;padding:2px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.wsm-error{margin:0;padding:2px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.wsm-row{display:flex;align-items:center;gap:8px;width:100%;min-height:48px;box-sizing:border-box;padding:4px 8px;border:none;border-radius:var(--dsw-radius-lg);background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;color:inherit;text-align:left}
.wsm-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.wsm-row:disabled{cursor:default}
.wsm-row:disabled .wsm-rowTitle,.wsm-row:disabled .wsm-rowPath{color:var(--dsw-alias-label-caption)}
.wsm-rowMain{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.wsm-rowTitle{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wsm-rowPath{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wsm-check{flex:none;display:inline-flex;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary)}
.wsm-check svg{width:14px;height:14px}
.wsm-separator{height:.5px;flex:none;margin:3px 8px;background:var(--dsw-alias-border-l2)}
.wsm-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:20px;padding:0 24px}
.wsm-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.wsm-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.wsm-button:disabled{cursor:not-allowed;opacity:.4}
.wsm-buttonOutline{border:.5px solid transparent;box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsh-button-outline-color,var(--dsw-alias-border-l3))}
.wsm-toast{position:fixed;top:40px;left:50%;z-index:1100;pointer-events:none;display:flex;align-items:center;gap:10px;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-family:inherit;font-size:14px;line-height:22px;box-shadow:var(--dsw-shadow-lv3);transform:translate(-50%);animation:wsm-toast-in .16s ease-out,wsm-fade 1s ease var(--dsh-toast-hold,3s) forwards}
.wsm-toastIcon{flex:none;display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;color:var(--dsw-alias-state-warn-label)}
.wsm-toastSuccess .wsm-toastIcon{color:var(--dsw-alias-state-success-primary)}
.wsm-toastError .wsm-toastIcon{color:var(--dsw-alias-state-error-primary)}
.wsm-toastIcon svg{width:16px;height:16px}
.wsm-ghost{position:fixed;z-index:1100;pointer-events:none;display:inline-flex;align-items:safe center;box-sizing:border-box;max-width:min(50vw,calc(100vw - 24px));padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-alias-tooltip-label);font-family:inherit;font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;-webkit-app-region:no-drag;animation:wsm-tooltip-in .15s var(--ds-ease-in-out)}
@keyframes wsm-toast-in{0%{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%)}}
@keyframes wsm-fade{to{opacity:0}}
@keyframes wsm-tooltip-in{0%{opacity:0}}
@media (prefers-reduced-motion:reduce){.wsm-dialog,.wsm-toast,.wsm-ghost{animation:none}}
@media (hover:hover){
.wsm-menuItem:hover:not(:disabled):not([aria-disabled=true]){background:var(--dsw-alias-interactive-bg-hover)}
.wsm-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wsm-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wsm-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
}
`

    /** Render the stylesheet as an element so unmounting removes it. */
    const Styles = () => h('style', { key: 'workspace-mover-styles' }, STYLES)

    // ---- shared view state -------------------------------------------------
    let version = 0
    const listeners = new Set()
    const emit = () => {
      version += 1
      for (const listener of [...listeners]) listener()
    }
    const subscribe = (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
    const snapshot = () => version

    /** Dialog request, toast, and the live drag chip. */
    const view = {
      /** { sessionId, title, loading, error, workspaces, currentId } */
      dialog: null,
      /** { text } */
      toast: null,
      /** { sessionId, target: { group, title, x, y } | null } */
      drag: null,
    }

    let toastTimer
    let toastSeq = 0
    /**
     * Show one transient notice in the host's toast seat.
     * @param text - localized line.
     * @param tone - `success` or `error`; picks the leading icon's colour.
     */
    const toast = (text, tone = 'success') => {
      toastSeq += 1
      view.toast = { text, tone, id: toastSeq }
      emit()
      if (toastTimer !== undefined) clearTimeout(toastTimer)
      // The sheet fades after --dsh-toast-hold (3s); drop the node after it.
      toastTimer = setTimeout(() => {
        view.toast = null
        emit()
      }, 4200)
    }

    // ---- host calls --------------------------------------------------------
    /** Resolve one Host route against the page's own directory base. */
    const hostUrl = (path) => {
      const base = new URL(document.baseURI)
      base.search = ''
      base.hash = ''
      if (!base.pathname.endsWith('/')) base.pathname += '/'
      return new URL(`${ROUTE}/${path.replace(/^\/+/, '')}`, base).href
    }

    /** Read the workspace catalog from the Host half. */
    const readState = async () => {
      const response = await fetch(hostUrl('state'), { headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok !== true) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`)
      return body
    }

    /** Ask the Host half to move one Session. */
    const requestMove = async (sessionId, workspaceId) => {
      const response = await fetch(hostUrl('move'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId, workspaceId }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok !== true) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`)
      return body
    }

    /** Describe a failure for a notice without leaking a stack. */
    const reason = (error) => error instanceof Error ? error.message : String(error)

    // ---- dialog ------------------------------------------------------------
    /** Which Workspace currently accounts a Session, per one catalog snapshot. */
    const workspaceOf = (state, sessionId) => state.workspaces
      .find(workspace => workspace.sessionIds.includes(sessionId))?.id ?? null

    /** Bumped by every open/close so a late catalog read cannot reopen or retarget the dialog. */
    let dialogSeq = 0

    /** Open the picker for one Session. */
    const openDialog = async (sessionId, title) => {
      dialogSeq += 1
      const seq = dialogSeq
      view.dialog = { sessionId, title, loading: true, error: null, workspaces: [], currentId: null }
      emit()
      try {
        const state = await readState()
        if (seq !== dialogSeq) return
        view.dialog = {
          sessionId,
          title,
          loading: false,
          error: null,
          workspaces: state.workspaces,
          currentId: workspaceOf(state, sessionId),
        }
      } catch (error) {
        if (seq !== dialogSeq) return
        view.dialog = {
          sessionId, title, loading: false, error: reason(error), workspaces: [], currentId: null,
        }
      }
      emit()
    }

    const closeDialog = () => {
      dialogSeq += 1
      view.dialog = null
      emit()
    }

    /** Move one Session and report the outcome. */
    const commitMove = async (sessionId, workspaceId) => {
      try {
        const result = await requestMove(sessionId, workspaceId)
        if (result.changed === false) toast(t('toast.same'))
        else if (result.workspace === null) toast(t('toast.removed'))
        else toast(t('toast.moved', { name: result.workspace.title }))
        return true
      } catch (error) {
        toast(t('toast.failed', { reason: reason(error) }), 'error')
        return false
      }
    }

    // ---- drag proxy --------------------------------------------------------
    /** The `data-row-key` of the element itself or its nearest marked ancestor. */
    const rowOf = (element) => element?.closest?.('[data-row-key]') ?? null

    /** The row's key without its kind prefix, or `undefined` for other rows. */
    const rowKey = (element, kind) => {
      const row = rowOf(element)
      const key = row?.getAttribute('data-row-key') ?? ''
      return key.startsWith(`${kind}:`) ? key.slice(kind.length + 1) : undefined
    }

    /** Which group the catalog places a Session in: a Workspace id, or `''` for Ungrouped. */
    const accountOf = (catalog, sessionId) => catalog === null
      ? undefined
      : catalog.workspaces.find(workspace => workspace.sessionIds.includes(sessionId))?.id ?? ''

    /**
     * Resolve the group a drop lands on, from the catalog rather than the DOM
     * tree: a header row names its group directly, and a Session row resolves
     * through the same account data the sidebar itself renders from. The host
     * sidebar wraps rows in hover-card components, so "the group section's first
     * child is its header" is not a shape a plugin may rely on.
     * @param element - the event target.
     * @param catalog - the last catalog read, or null while it is unknown.
     * @returns the target group key (Workspace id or `''`), or undefined.
     */
    const groupAt = (element, catalog) => {
      const workspaceId = rowKey(element, 'workspace')
      if (workspaceId !== undefined) return workspaceId
      const sessionId = rowKey(element, 'session')
      if (sessionId === undefined) return undefined
      const account = accountOf(catalog, sessionId)
      // A row whose session is unaccounted (a blank "new session" row, or a
      // session that is not in any workspace) names no target: resolving it as
      // Ungrouped would turn a drop onto that row into an accidental detach.
      return account === '' ? undefined : account
    }

    /**
     * Install the capture-phase drag bridge for the lifetime of the plugin.
     * @param ctx - Client plugin context; its effect owns the listeners.
     */
    const installDragBridge = (ctx) => {
      /** Session row being dragged, or null when no session drag is in flight. */
      let dragged = null
      /** Last successful catalog read; the drop target's group is resolved from it. */
      let catalog = null

      /** Refresh the catalog, keeping the last good one when the read fails. */
      const refreshCatalog = () => {
        readState().then((state) => { catalog = state }).catch(() => {})
      }

      const titleOf = (group) => group === ''
        ? t('menu.ungrouped')
        : catalog?.workspaces.find(workspace => workspace.id === group)?.title ?? group

      /** The session drag this event belongs to, or undefined when it is not ours. */
      const dragOf = (event) => {
        if (dragged === null) return undefined
        const types = event.dataTransfer?.types
        if (types !== undefined && !Array.from(types).includes('text/plain')) {
          // A file or text drag from outside the sidebar: never a session move.
          reset()
          return undefined
        }
        return dragged
      }

      const reset = () => {
        if (dragged === null && view.drag === null) return
        dragged = null
        view.drag = null
        emit()
      }

      const onDragStart = (event) => {
        const sessionId = rowKey(event.target, 'session')
        if (sessionId === undefined) {
          reset()
          return
        }
        dragged = sessionId
        view.drag = { sessionId, target: null }
        emit()
        refreshCatalog()
      }

      const onDragOver = (event) => {
        const sessionId = dragOf(event)
        if (sessionId === undefined) return
        if (catalog === null) return // unknown target groups: leave the drop to the host
        const group = groupAt(event.target, catalog)
        const source = accountOf(catalog, sessionId)
        if (group === undefined || source === undefined || group === source) {
          if (view.drag?.target != null) {
            view.drag = { ...view.drag, target: null }
            emit()
          }
          return
        }
        // Own this drop: the built-in browser would otherwise reject a
        // cross-group target and paint a "no drop" cursor.
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
        const target = { group, title: titleOf(group), x: event.clientX, y: event.clientY }
        const previous = view.drag?.target
        if (previous !== null && previous !== undefined && previous.group === group
          && Math.abs(previous.x - target.x) < 8 && Math.abs(previous.y - target.y) < 8) return
        view.drag = { sessionId, target }
        emit()
      }

      const onDrop = (event) => {
        const sessionId = dragOf(event)
        if (sessionId === undefined) return
        const group = catalog === null ? undefined : groupAt(event.target, catalog)
        const source = accountOf(catalog, sessionId)
        if (group === undefined || source === undefined || group === source) {
          reset()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        reset()
        void commitMove(sessionId, group === '' ? null : group)
      }

      const onDragEnd = () => { reset() }
      /** A drag that leaves the window never reports dragend on the source row. */
      const onWindowBlur = () => { reset() }
      const onDragLeave = (event) => {
        // `relatedTarget` is null for most dragover-to-dragleave transitions in
        // Chromium, so it cannot mean "left the window". Require the pointer to
        // actually be outside the viewport before cancelling.
        if (event.relatedTarget !== null) return
        const outside = event.clientX <= 0 || event.clientY <= 0
          || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
        if (outside) reset()
      }

      // Warm the catalog at activation so the first drag can resolve targets
      // immediately instead of waiting on a round trip.
      refreshCatalog()

      document.addEventListener('dragstart', onDragStart, true)
      document.addEventListener('dragover', onDragOver, true)
      document.addEventListener('drop', onDrop, true)
      document.addEventListener('dragend', onDragEnd, true)
      document.addEventListener('dragleave', onDragLeave, true)
      window.addEventListener?.('blur', onWindowBlur)
      return () => {
        document.removeEventListener('dragstart', onDragStart, true)
        document.removeEventListener('dragover', onDragOver, true)
        document.removeEventListener('drop', onDrop, true)
        document.removeEventListener('dragend', onDragEnd, true)
        document.removeEventListener('dragleave', onDragLeave, true)
        window.removeEventListener?.('blur', onWindowBlur)
        reset()
      }
    }

    // ---- components --------------------------------------------------------
    /** Re-render on shared view changes. */
    const useView = () => {
      if (typeof React.useSyncExternalStore === 'function') {
        React.useSyncExternalStore(subscribe, snapshot)
        return
      }
      const [, bump] = React.useState(0)
      React.useEffect(() => subscribe(() => bump(value => value + 1)), [])
    }

    /** 16px close glyph, matching the Modal's own close affordance. */
    const CloseIcon = () => h('svg', {
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
    }, h('path', { d: 'M4 4l8 8M12 4l-8 8' }))

    /**
     * 14px "move into a group" glyph for the menu row: one arrow entering an
     * open container. Two side-by-side boxes were unreadable at menu size.
     */
    const MoveIcon = () => h('svg', {
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
    h('path', { d: 'M9.2 2.9h2.6a1.2 1.2 0 0 1 1.2 1.2v7.8a1.2 1.2 0 0 1-1.2 1.2H9.2' }),
    h('path', { d: 'M2.4 8h6.4' }),
    h('path', { d: 'M6.6 5.8 8.9 8l-2.3 2.2' }))

    /** 14px check, the host's marker for the row that already holds the value. */
    const CheckIcon = () => h('svg', {
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }, h('path', { d: 'M3.4 8.6 6.4 11.6 12.6 5.4' }))

    /** 16px status glyph for the toast seat: check for success, exclamation for a failure. */
    const StatusIcon = ({ tone }) => h('span', { className: 'wsm-toastIcon', 'aria-hidden': 'true' },
      tone === 'success'
        ? h('svg', {
          viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }, h('path', { d: 'M3.4 8.6 6.4 11.6 12.6 5.4' }))
        : h('svg', {
          viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        },
        h('circle', { cx: 8, cy: 8, r: 6.2 }),
        h('path', { d: 'M8 5v3.6' }),
        h('path', { d: 'M8 11.2h.01' })))

    /** One pickable Workspace row. */
    const Row = ({ label, detail, current, onPick }) => h('button', {
      type: 'button',
      className: 'wsm-row',
      'aria-current': current ? 'true' : undefined,
      onClick: onPick,
    },
    h('span', { className: 'wsm-rowMain' },
      h('span', { className: 'wsm-rowTitle' }, label),
      detail !== undefined && h('span', { className: 'wsm-rowPath' }, detail)),
    current && h('span', { className: 'wsm-check' }, h(CheckIcon)))

    /** The picker dialog. */
    const Dialog = ({ dialog }) => {
      const panel = React.useRef?.(null) ?? { current: null }
      React.useEffect?.(() => {
        const previous = document.activeElement
        panel.current?.focus?.()
        const focusables = () => [...(panel.current?.querySelectorAll?.(
          'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [])]
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeDialog()
            return
          }
          // Contain Tab inside the card: aria-modal alone does not stop the
          // browser from walking into the page behind the mask.
          if (event.key !== 'Tab' || panel.current === null) return
          const items = focusables()
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
          if (previous?.isConnected === true) previous.focus?.()
        }
      }, [])
      const rows = []
      if (dialog.loading) {
        rows.push(h('p', { key: 'loading', className: 'wsm-note', role: 'status' }, t('dialog.loading')))
      } else if (dialog.error !== null) {
        rows.push(h('p', { key: 'error', className: 'wsm-error', role: 'alert' }, t('dialog.failed', { reason: dialog.error })))
      } else if (dialog.workspaces.length === 0) {
        rows.push(h('p', { key: 'empty', className: 'wsm-note', role: 'status' }, t('dialog.empty')))
      } else {
        for (const workspace of dialog.workspaces) {
          const current = workspace.id === dialog.currentId
          rows.push(h(Row, {
            key: workspace.id,
            label: workspace.title,
            detail: workspace.path,
            current,
            onPick: () => {
              closeDialog()
              if (current) return
              void commitMove(dialog.sessionId, workspace.id)
            },
          }))
        }
        if (dialog.currentId !== null) {
          rows.push(h('span', { key: 'separator', className: 'wsm-separator' }))
          rows.push(h(Row, {
            key: 'ungrouped',
            label: t('dialog.ungrouped'),
            onPick: () => {
              closeDialog()
              void commitMove(dialog.sessionId, null)
            },
          }))
        }
      }
      const titleId = 'workspace-mover-title'
      return h('div', { className: 'wsm-overlay', role: 'presentation' },
        h('div', {
          className: 'wsm-mask',
          'aria-hidden': 'true',
          onClick: closeDialog,
        }),
        h('div', {
          ref: panel,
          className: 'wsm-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          tabIndex: -1,
        },
        h('div', { className: 'wsm-header' },
          h('h2', { className: 'wsm-title', id: titleId }, t('dialog.title')),
          h('button', {
            type: 'button',
            className: 'wsm-close',
            'aria-label': t('dialog.close'),
            onClick: closeDialog,
          }, h(CloseIcon))),
        h('p', { className: 'wsm-desc' }, dialog.title === ''
          ? t('dialog.descUntitled')
          : t('dialog.desc', { name: dialog.title })),
        h('div', { className: 'wsm-body' }, rows),
        h('div', { className: 'wsm-footer' },
          h('button', {
            type: 'button',
            className: 'wsm-button wsm-buttonOutline',
            onClick: closeDialog,
          }, t('dialog.cancel')))))
    }

    /** Drag chip and notice, both anchored to the viewport. */
    const Overlay = () => {
      useView()
      const layers = [h(Styles, { key: 'styles' })]
      if (view.drag?.target != null) {
        layers.push(h('div', {
          key: 'ghost',
          className: 'wsm-ghost',
          style: { left: `${view.drag.target.x + 12}px`, top: `${view.drag.target.y + 16}px` },
        }, view.drag.target.group === ''
          ? t('drop.ungrouped')
          : t('drop.into', { name: view.drag.target.title })))
      }
      if (view.toast !== null) {
        const { text, tone, id } = view.toast
        layers.push(h('div', {
          key: `toast-${id}`,
          className: tone === 'error' ? 'wsm-toast wsm-toastError' : 'wsm-toast wsm-toastSuccess',
          role: tone === 'error' ? 'alert' : 'status',
        }, h(StatusIcon, { tone }), h('span', null, text)))
      }
      if (view.dialog !== null) layers.push(h(Dialog, { key: 'dialog', dialog: view.dialog }))
      return h(React.Fragment, null, layers)
    }

    /** Session row menu entry. */
    const MoveMenuItem = ({ sessionId, displayTitle, useMenuOpenState }) => {
      const [, setMenuOpen] = useMenuOpenState()
      return h(React.Fragment, null,
        h(Styles, { key: 'styles' }),
        h('button', {
          type: 'button',
          role: 'menuitem',
          className: 'wsm-menuItem',
          onClick: () => {
            setMenuOpen(false)
            void openDialog(sessionId, displayTitle)
          },
        },
        h('span', { className: 'wsm-menuIcon', 'aria-hidden': 'true' }, h(MoveIcon)),
        h('span', { className: 'wsm-menuLabel' }, t('menu.move'))))
    }

    // Bound at apply time so every component reads the live locale.
    let t = (key) => ZH[key] ?? key

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          ctx.effect(() => locale.register(NS, 'zh', ZH), 'workspace-mover: zh dictionary')
          ctx.effect(() => locale.register(NS, 'en', EN), 'workspace-mover: en dictionary')
          t = locale.bind(NS)
        }

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'workspace-mover.move', order: 300 },
          MoveMenuItem,
        ))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'workspace-mover.overlay' },
          Overlay,
        ))

        ctx.effect(() => installDragBridge(ctx), 'workspace-mover: drag bridge')
        ctx.effect(() => () => {
          if (toastTimer !== undefined) clearTimeout(toastTimer)
          toastTimer = undefined
          view.dialog = null
          view.drag = null
          view.toast = null
          dialogSeq += 1
        }, 'workspace-mover: transient state')
      },
    }
  },
})
