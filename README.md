# Simple OT Editor

A small educational collaborative editor that demonstrates real-time multi-user editing on `localhost` using Operational Transform (OT) implemented directly in the project.

Open the app in two or more browser tabs, type in both tabs at the same time, and watch the document converge as the server rebases concurrent insert and delete operations before broadcasting them back out.

## Why This Exists

Most collaborative editing demos hide the core behavior behind large collaboration frameworks, CRDT libraries, or hosted sync services. This project does the opposite:

- It uses plain browser JavaScript on the frontend.
- It uses a small Node.js server with an in-memory document store.
- It implements a minimal OT engine from scratch for plain text.
- It keeps the architecture small enough that a GitHub reader can understand the full flow in one sitting.

That makes it useful as:

- an educational OT reference
- a local demo for product or engineering conversations
- a starting point for experimenting with collaborative editing ideas

## What Makes It Notable

- No collaboration frameworks
- No OT or CRDT libraries
- No external database
- No build step
- Explicit operation objects, revision numbers, rebasing, and acknowledgements
- A lightweight UI that exposes tenant/session metadata, sync state, editor capacity, reconnect testing, session reset, and basic rich text controls

## Project Structure

```text
simple-ot-editor/
  package.json
  server.js
  README.md
  docs/
    architecture.md
    demo-script.md
  src/
    ot.js
    store.js
  public/
    index.html
    styles.css
    app.js
```

## Quick Start

### Requirements

- Node.js 18+

### Run Locally

```bash
cd /Users/manu/Documents/project/simple-ot-editor
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in two or more browser tabs.

### Local Demo Flow

1. Open `http://localhost:3000/?tenant=acme` in up to three tabs to join as active editors.
2. Open the same tenant in a fourth tab to see the read-only viewer mode.
3. Disconnect one editor tab or close it, then watch the viewer get promoted into an editor slot.
4. Open a different tenant such as `http://localhost:3000/?tenant=globex` to see isolated document state.

To try tenant isolation, append a tenant id:

```text
http://localhost:3000/?tenant=acme
http://localhost:3000/?tenant=globex
```

### Local Data

- Tenant documents are stored in `data/tenants.json`
- Delete that file or use the in-app `Reset` button if you want to start from a clean local state

You can also:

- click the sync button to disconnect a single tab, make local-only edits, and reconnect later
- click `Reset` to restore the shared document and revision history to the initial demo state

## How The Demo Works

Each tenant gets its own shared document. Within a tenant, local edits are converted into one or two linear text operations over the document's serialized HTML:

- `insert`: insert characters into the HTML string
- `delete`: remove characters from the HTML string

Every operation includes:

- client id
- operation id
- base revision
- position
- inserted text or deleted length

The browser renders that HTML inside a `contenteditable` editor with formatting controls for bold, italics, underline, text color, and block style changes. The first three users in a tenant are active editors. Additional users join as read-only viewers until an editor slot opens. The client applies its own edits optimistically, sends them to the server, and waits for an acknowledgement. If another client’s operation arrives first, the local pending operation is transformed so both users still converge on the same final HTML document.

## OT Overview In Simple Language

Operational Transform is a way to keep multiple editors in sync when people make changes at the same time.

Instead of sending the entire document on every keystroke, clients send small edit operations such as:

- “insert `A` at position 5”
- “delete 3 characters starting at position 10”

If two people edit concurrently, one operation may need to be adjusted before it can be applied cleanly on top of the other. That adjustment is the “transform” part.

Examples:

- If another user inserts text before your insert position, your insert shifts to the right.
- If another user deletes text before your cursor, your edit may shift to the left.
- If two deletes overlap, the second delete is reduced so the same characters are not removed twice.

This demo implements those transform rules directly in [`src/ot.js`](/Users/manu/Documents/project/simple-ot-editor/src/ot.js).

## Architecture Summary

- The browser keeps local editor state, one pending operation, a small buffer, a manual disconnect mode, and a rich text toolbar layered on top of `contenteditable`.
- The server keeps tenant-scoped authoritative document text, revision counters, role assignment, and operation history.
- The server rebases incoming operations against anything committed since the sender’s `baseRevision`.
- The server increments the revision and broadcasts the committed operation.
- Other clients apply the remote operation and rebase any local pending work.
- A disconnected tab keeps its draft locally; on reconnect it diffs that draft against the latest server snapshot and submits the resulting operations.
- Local persistence stores tenant documents in `data/tenants.json` so a restart does not wipe the working set.

More detail is in [`docs/architecture.md`](/Users/manu/Documents/project/simple-ot-editor/docs/architecture.md).

## Tradeoffs And Limitations

- Rich text is implemented as editable HTML rather than a structured document model
- Single shared document per tenant
- Local JSON-file persistence only
- No auth
- No cursor presence
- No undo/redo
- The WebSocket implementation is intentionally minimal and only supports what this demo needs
- The client-side diff logic assumes a single contiguous edit per `input` event, which is fine for a local educational demo but not a full editor engine
- Formatting is synchronized as HTML string edits, so markup-level conflicts are more fragile than a real rich-text OT or CRDT model
- Offline reconnect is intentionally simple: a disconnected tab turns its local draft into fresh operations on reconnect rather than performing a full historical offline rebase
- Viewer promotion is first-available, not a formal waitlist

## Future Improvements

- Add auth and per-tenant authorization
- Add support for multiple named documents within a tenant
- Preserve selections and cursors more carefully during remote updates
- Add automated transform tests for more concurrency scenarios
- Add reconnect and resync flows after disconnects
- Replace local JSON persistence with SQLite or PostgreSQL when durability and audit needs increase
- Add a richer event inspector for showing raw operations live

## Demo Script

1. Start the server and open the app in two tabs.
2. Point out the connected users, session id, sync state, and revision counter.
3. Type in one tab and show the other tab updating instantly.
4. Type in both tabs at nearly the same time to show concurrent edits converging.
5. Explain that every change is being represented as insert/delete operations rather than whole-document sync.
6. Explain that the OT engine is implemented directly in the project, without any collaboration framework.

A more presentation-oriented narrative is in [`docs/demo-script.md`](/Users/manu/Documents/project/simple-ot-editor/docs/demo-script.md).

## Why Building It Without Collaboration Frameworks Is Interesting

It strips the problem down to the core mechanics:

- operation modeling
- revision tracking
- conflict handling
- optimistic UI
- server acknowledgement

That makes the project a useful teaching tool. It shows the shape of a collaborative editor without the abstractions that usually hide the interesting part.
