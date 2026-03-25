# Architecture

## Why OT Was Chosen

This demo uses Operational Transform because the goal is to show the core mechanism behind collaborative text editing in a way that is easy to inspect.

For a plain-text, single-document localhost demo, OT is a good fit because:

- operations are small and explicit
- revision-based rebasing is easy to explain
- the server can stay authoritative
- the concurrency story is visible in a compact amount of code

This project is not arguing that OT is always better than CRDTs. It is choosing OT because it gives a clean teaching model for a small centralized demo.

The current editor is rich text in the browser, but the synchronization model is still linear OT over serialized HTML. That is an intentional simplification for readability.

The server now also models a short-term production-like shape:

- tenant-scoped documents
- a maximum of 3 concurrent editors per tenant
- extra users joining as read-only viewers
- lightweight JSON persistence on local disk

## High-Level System

- The browser renders a `contenteditable` surface and sends linear text operations over the document's HTML string.
- The server keeps tenant-scoped authoritative documents, revision history, and editor/viewer role assignment.
- The OT engine rebases operations whenever concurrent edits exist.
- The server acknowledges the sender and broadcasts the committed operation to everyone else.
- Tabs can also manually disconnect, keep editing locally, then reconnect and submit their draft as fresh operations against the latest server snapshot.
- Tenant documents are persisted to a local JSON file so a restart does not wipe the working set.

## Operation Shape

```js
{
  id: "client-2:14",
  clientId: "client-2",
  baseRevision: 8,
  type: "insert",
  pos: 42,
  text: "hello"
}
```

Delete operations replace `text` with `length`.

The important idea is that operations target a known document revision. If the document has moved on since then, the server transforms the operation before committing it.

## Operation Flow

1. A user opens a tenant session such as `/?tenant=acme`.
2. The server assigns the user an `editor` role if fewer than 3 editors are active in that tenant. Otherwise the user is a read-only `viewer`.
3. An editor types into the rich text surface.
4. The browser computes a minimal contiguous change between the old and new HTML.
5. The browser turns that into one or two operations:
   - delete first, if text was removed
   - insert second, if text was added
6. The browser applies the change optimistically and sends the operation to the server.
7. The server checks the client’s `baseRevision`.
8. If newer operations already exist, the server rebases the incoming operation across those concurrent operations.
9. The server applies the transformed operation to the canonical tenant document.
10. The server increments the revision, stores the committed operation in history, acknowledges the sender, broadcasts the committed operation, and persists the new document state.
11. Other clients in the same tenant apply the remote operation and transform any pending local work against it.
12. If a tab was manually disconnected, it reconnects, receives the latest snapshot, computes a fresh diff between that snapshot and its local draft, and submits those operations if it still has an editor role.
13. If an editor disconnects, the server promotes the first available viewer in that tenant into the open editor slot.

## Transform Logic At A High Level

The core rules live in [`src/ot.js`](/Users/manu/Documents/project/simple-ot-editor/src/ot.js).

### Insert vs insert

If another insert lands before your insert, your position shifts right by the inserted text length.

If both inserts target the same position, a deterministic tie-breaker based on client id and operation id decides which one comes first. That matters because every client must make the same choice.

### Insert vs delete

If a delete removes content before your insert position, your insert shifts left.

If your insert falls inside text that was deleted concurrently, this demo marks the insert as a no-op. That is a simplification to keep the model convergent with a compact implementation.

### Delete vs insert

If another insert happens before your delete range, your delete shifts right.

If another insert lands inside the range you intended to delete, the delete expands so it still removes the same original characters.

### Delete vs delete

If two delete ranges are disjoint, positions shift normally.

If they overlap, the second delete is reduced so the overlapping characters are not deleted twice.

## Server Responsibilities

`server.js` does five jobs:

- serves the static frontend
- accepts WebSocket connections
- manages tenant-scoped presence and editor/viewer roles
- commits operations into the document store
- promotes viewers when an editor slot opens

The document store is intentionally simple:

- one document per tenant
- one revision counter per tenant
- one history array per tenant
- local JSON persistence
- resettable back to the initial demo document

## Client Responsibilities

`public/app.js` keeps:

- the current visible text
- the known server revision
- one pending operation waiting for acknowledgement
- a small local buffer of additional edits
- the current tenant id and assigned role

This is enough to demonstrate:

- optimistic local editing
- server acknowledgement
- rebasing local work when remote edits arrive first
- a lightweight manual disconnect/reconnect demo flow
- basic rich text controls layered over the same OT pipeline
- read-only viewers beyond the 3-editor tenant cap

## Limitations

- Single shared document per tenant
- Rich text synchronization is HTML-string based, not structure-aware
- Minimal diffing strategy
- Minimal WebSocket framing support
- Reconnect recovery is intentionally draft-based rather than a full offline operation journal
- Persistence is local JSON only, not a durable multi-node database
- No formal test suite yet

Those limitations are intentional. The point is to make the mechanics understandable, not production-ready.
