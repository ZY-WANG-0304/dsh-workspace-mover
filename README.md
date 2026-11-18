# dsh-workspace-mover

[![test](https://github.com/ZY-WANG-0304/dsh-workspace-mover/actions/workflows/test.yml/badge.svg)](https://github.com/ZY-WANG-0304/dsh-workspace-mover/actions/workflows/test.yml)

Move DSH sessions between workspaces — from the session row menu, or by dragging
the row onto another workspace group in the sidebar.

- `⋯` on a session row → **Move to workspace** → pick a workspace (or leave
  every workspace).
- Or drag the row onto another workspace's group and drop it; drag onto the
  **Ungrouped** header to move it out.
- A drag chip names the target while you hover it; a toast confirms the move.

Membership only: session logs, files and any running work are untouched. The
sidebar repaints from DSH's own `workspace/follow` stream.

## Install

Published as a DSH bundle.

- **Desktop app:** **Plugins → Add plugin** → `dsh-workspace-mover`.
- **A CLI profile:** `dsh plugin --profile <name> add dsh-workspace-mover`.

Restart the Host once after installing so the Host half installs its registry
wrappers (the Client half reloads with the page).

## How it works (and its one caveat)

DSH binds a session's workspace membership to the immutable `SessionHeader.cwd`,
and has no API for reassigning an existing session. This plugin keeps a small
durable map (`$DSH_HOME/storages/workspace-mover.json`) for moves whose cwd
differs from the target directory, and wraps two internal registry seams so
those moves survive reads, writes, restarts and forking. Moves into a workspace
that already owns the session's directory need no map entry at all.

The wrapped seams are internal, not public API: on a DSH release that changes
their shape the plugin logs why and degrades (falls back to native validation)
instead of half-applying a move. Uninstalling needs a Host restart to drop the
wrappers; after that, only cross-directory moves revert to Ungrouped.

See [docs/DETAIL.md](docs/DETAIL.md) for the data model, failure handling and the
UI mapping onto DSH's design system.

## Tests

No DSH runtime needed — both halves are exercised against stand-ins:

```sh
node test/host.test.mjs     # fake registry + fake web server
node test/client.test.mjs   # stub module loader, stub React, fake DOM
```

CI runs both on Node 20 and 22 ([workflow](.github/workflows/test.yml)).

## Licence

MIT
