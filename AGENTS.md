# AGENTS.md

TypeScript pi package, Node 22.19+. The extension is in
`extensions/side-agent/`. It opens a side agent: a second pi process in RPC
mode, shown in a resizable overlay, with a bridge to the main session.

| File | Role |
|---|---|
| `index.ts` | Host entry: commands, toggle key, message renderer, shutdown hook |
| `controller.ts` | Side process lifecycle, window lifecycle, side window commands |
| `view.ts` | Window component: frame, block rendering, scrolling, picker, input |
| `transcript.ts` | Builds conversation blocks from pi RPC records |
| `jsonl.ts` | Stream reader that drops unwanted records by their first bytes |
| `process.ts` | Spawns `pi --mode rpc`, correlates RPC responses, carries the IPC bridge |
| `main-bridge.ts` | Main-session side of the bridge: read, snapshot, send, reply waits |
| `child.ts` | Bridge extension loaded in the side agent process with `-e` |
| `layout.ts`, `protocol.ts` | Window geometry and config; shared names and message shapes |

`tests/` holds unit tests and integration tests that run a real pi process
with `tests/support/scripted-provider.mjs`. `evals/bench.mjs` measures host
cost. `evals/run.mjs` grades live-model runs.

- Never stash or discard working changes. Preserve concurrent user edits.
- Search for existing functionality before adding types or helpers.
- After code changes, run `npm test` and `npm run typecheck`. Fix every failure
  before reporting the change done.
- After a change to `jsonl.ts`, `transcript.ts`, `view.ts`, or the record
  handling in `controller.ts`, run `npm run bench` and compare with the table
  in `README.md`. Update the table when a number moves.
- After a change to `child.ts`, `main-bridge.ts`, or the prompt in
  `protocol.ts`, run `npm run eval` with a small model. After a change to the
  window's keys or to the stop, close, and report paths in `controller.ts`,
  run `npm run eval -- --only window`. It costs tokens; say so before running
  it for someone else.
- Never append a comment-lint `allow(...)` override marker. Rewrite or delete
  the comment instead. `.githooks/pre-commit` checks staged additions with
  `scripts/forbid-comment-markers.sh --staged`. Enable it with
  `git config --local core.hooksPath .githooks`.

## Invariants

Tests fail when one of these breaks. Keep them when you change the code.

- `index.ts` registers nothing in a side agent process (`PI_SIDE_AGENT_CHILD=1`),
  and `child.ts` registers nothing outside one.
- Before the window first opens, the host has started no process and has
  registered no main-session handler except `session_shutdown`. The main
  agent gets no tool.
- `MainBridge` listens to main-session events only between `attach` and
  `detach`.
- An unchanged frame is returned from the frame cache. A frame renders only
  the blocks it shows. A delta re-renders only its block.
- Every rendered line is exactly the given width, and a frame is exactly the
  window's row count.
- Every change to `Transcript.activity()` advances `Transcript.version`.
- Only a draw of an active window sets the spinner timer, one at a time. The
  animation stops when pi stops drawing the window, and an idle or disposed
  window requests no frame.
- Escape closes the window and sends the side agent nothing. Only ctrl+c on an
  empty composer stops the side agent's work, and it sends `clear_queue`
  before `abort` so queued messages return to the composer.
- The footer status is set only while the window is closed, and is written
  only when its text changes. A run stopped with ctrl+c produces no completion
  notice.
- A callback from the side process stream or IPC channel never throws into
  the host.
- The side agent process exits when the host stops it and when the host dies.

## What gets committed

- Commit production code and tests that stay. Exploratory code and comparison
  arms run outside the repo.
- Ship one implementation per mechanism. Do not add a fallback, a second
  backend, or a runtime switch between approaches unless the user approves a
  specific reason.

## Writing

Write prose, comments, and commit messages in plain, direct language. Lead
with the claim or the action. State what the code does and the invariant it
keeps. Do not use em dashes. Comments explain invariants, preconditions, and
failure modes that names do not convey; delete comments that restate code.
