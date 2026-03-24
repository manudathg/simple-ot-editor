# Demo Narrative

## What It Is

This is a small collaborative web editor running entirely on localhost. Multiple browser tabs can edit the same shared document in real time, and the app keeps everyone synchronized using Operational Transform.

## Why It Matters

Collaborative editing is one of those experiences people take for granted, but it hides a real coordination problem: two people can change the same text at nearly the same time, and the system still has to make every editor converge on one consistent document.

This project makes that behavior visible in a compact, understandable way.

## Why Building It Without Collaboration Frameworks Is Interesting

Most real-time demos rely on a collaboration platform or an existing shared-editing engine. That is practical, but it also hides the part that is technically interesting.

This demo implements the OT model directly:

- operations are created in the browser
- revisions are tracked on the server
- concurrent operations are transformed explicitly
- acknowledgements and broadcasts are handled by a tiny custom stack

That makes it easier to explain what is actually happening under the hood.

## Art Of Possible

This demonstrates that:

- collaborative editing can be prototyped with a very small amount of code
- the core idea is understandable without heavyweight infrastructure
- a product team can reason about real-time behavior from first principles
- a public GitHub reader can inspect the architecture without needing specialized domain libraries

## Suggested Live Walkthrough

1. Start the server and open the app in two tabs.
2. Point out the user list, sync badge, and revision counter.
3. Type in one tab to show immediate propagation.
4. Type in both tabs at the same time to show concurrency handling.
5. Explain that each keystroke becomes an explicit insert or delete operation.
6. Explain that the server rebases late-arriving operations against newer ones before committing them.
7. Close with the point that this is the smallest useful version of collaborative editing, built without collaboration frameworks.
