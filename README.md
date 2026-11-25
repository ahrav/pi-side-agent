# pi-side-agent

A side agent for [pi](https://pi.dev): a second, full pi agent in a resizable
window next to the agent you are working with.

The side agent is a real pi process. It loads the tools, skills, extensions,
and MCP servers your normal pi sessions load, keeps its own model and session,
and runs while the main agent runs. It can read the main agent's session and
send the main agent messages.

```text
╭─ side agent · provider/model ──────────────────────────────────── idle · ctx 8% · $0.01 ─╮
│ ❯ What did the main agent just do? Then ask it which file it created.                    │
│                                                                                          │
│ ✓ main_agent_send Which file did you create in your last task?  6.3s                     │
│                                                                                          │
│ The main agent created notes.md with one line and reported that it was done.             │
│                                                                                          │
│ I asked it which file it created, and it answered: notes.md.                             │
│                                                                                          │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ alt+a main · esc close · pgup/pgdn scroll · alt+m max · alt+=/- size · /help             │
╰──────────────────────────────────────────────────────────────────────────────────────────╯
```

The idea of a side conversation comes from
[pi-btw](https://github.com/dbachelder/pi-btw). This package keeps that idea
and changes the design: the side agent is a separate pi process with your full
configuration, its window resizes up to the whole terminal, and the two agents
can exchange messages.

## Install

```bash
pi install git:github.com/ahrav/pi-side-agent
```

Run `/reload` or restart pi. To try it for one session without installing:

```bash
pi -e /path/to/pi-side-agent
```

It needs Node.js 22.19 or newer. It is built and tested against pi 1.6.1.
Older pi versions are untested.

## Use

`/sa` opens the side window. `/side-agent` is the same command. Text after the
command goes to the side agent:

```text
/sa why does the build fail on Linux only?
```

`alt+a` opens the window, or moves focus between the window and the main
editor. The window stays visible while you type to the main agent.

Type in the window's composer and press Enter. The side agent starts with the
window and is ready in the time pi takes to start: 2 to 3 seconds with a large
configuration. A prompt you send before that waits and is sent when the side
agent is ready.

Esc stops a running side turn. Esc on an idle window closes it. The side agent
keeps running while the window is closed, and pi shows a notice when it
finishes.

### Window size

The window opens at 92% of the terminal width and 90% of its height.

| Action | Effect |
|---|---|
| `alt+m` | Maximize to the whole terminal, or restore the previous size |
| `alt+=`, `alt+-` | Grow or shrink by 5 points |
| `/size <width%> [height%]` | Set the size, for example `/size 95 85` |
| `/size full` | Whole terminal |
| `/dock center` | Centered, 92% by 90% |
| `/dock left`, `/dock right` | Half the width at full height, on that edge |
| `/dock top`, `/dock bottom` | Full width at half height, on that edge |

A docked window grows and shrinks along its free axis. Sizes are between 30%
and 100%. The layout is saved and used the next time.

Inside the window, PageUp and PageDown scroll the transcript, `ctrl+home`
jumps to its start, and `ctrl+end` returns to the newest output. In fullscreen
mode the mouse wheel scrolls it.

### Model

The side agent has its own model and thinking level. The first time, it starts
on the main agent's current model and thinking level. After you choose a model
for it, it starts on that model.

| Action | Effect |
|---|---|
| `/model` or `ctrl+l` | Open a model picker with search. Your scoped models are listed first, marked ★ |
| `/model <text>` | Select the model that matches, or open the picker filtered to the text |
| `ctrl+p` | Cycle to the next model, through your scoped models when you have any |
| `shift+tab` | Cycle the thinking level |
| `/thinking <level>` | Set the thinking level. `/thinking` lists the levels |

The keys are pi's own actions (`app.model.select`, `app.model.cycleForward`,
`app.thinking.cycle`), so your `keybindings.json` applies. The main agent's
model does not change.

### Talking to the main agent

The side agent gets two tools:

| Tool | What it does |
|---|---|
| `main_agent_read` | Returns the main agent's status (idle or working, running tools, model, context use) and its recent conversation: user prompts, assistant text, tool calls, and clipped tool output. It pages backwards and filters by text. |
| `main_agent_send` | Sends a message into the main agent's session. `steer` delivers it after the main agent's current tool calls, or starts a turn when the main agent is idle. `follow_up` delivers it after the main agent finishes. `next_turn` attaches it to the main agent's next turn. With `wait_for_reply`, the call returns the main agent's reply text. |

You ask in plain words:

```text
What is the main agent working on?
Tell the main agent to add a logout endpoint once it finishes.
Ask the main agent which branch it is on and tell me what it says.
```

The side agent does not carry the main conversation in its context. Each side
turn receives a short snapshot of the main agent: its status, the latest user
message, and the latest assistant text. The side agent reads further back with
`main_agent_read` when a question needs it.

A message from the side agent appears in the main transcript under the label
`side agent`, and the main agent reads it as a message from your second
agent. The side agent sends only when you ask it to.

`/send [note]` in the side window sends the side agent's last answer to the
main agent directly, without a model call.

### Side window commands

| Command | Effect |
|---|---|
| `/model [text]`, `/thinking [level]` | See [Model](#model) |
| `/size ...`, `/dock ...` | See [Window size](#window-size) |
| `/send [note]` | Send the last answer to the main agent |
| `/copy` | Copy the last answer to the clipboard |
| `/new` | Start a new side session with the same model |
| `/compact [instructions]` | Compact the side session's context |
| `/quit` | Stop the side agent process and close the window |
| `/help` | List commands and keys |

Any other `/command` runs in the side agent: skills (`/skill:name`), prompt
templates, and extension commands. The composer completes both sets.

Other keys: `alt+enter` queues a follow-up message, `ctrl+o` shows tool output,
`ctrl+t` folds thinking, and `ctrl+c` clears the draft, then closes the window.

## Configuration

`~/.pi/agent/side-agent.json` holds the window layout, the side agent's model
and thinking level, and the toggle key. The extension writes it when you
resize the window or choose a model. Edit `toggleKey` to move the shortcut,
then run `/reload`:

```json
{
  "window": { "dock": "center", "width": 92, "height": 90 },
  "toggleKey": "alt+a",
  "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
  "thinkingLevel": "medium"
}
```

`toggleKey` takes pi's key syntax, such as `ctrl+alt+k`. On macOS, an alt key
needs a terminal that sends Option as Meta.

## How it works

```text
main pi process                                   side agent process
┌──────────────────────────────────┐   stdin     ┌──────────────────────────────┐
│ index.ts      commands, key      │ ──────────▶ │ pi --mode rpc                │
│ controller.ts window, lifecycle  │   RPC JSONL │   your extensions, skills,   │
│ process.ts    spawn, RPC client  │ ◀────────── │   MCP servers, tools         │
│ jsonl.ts      stream reader      │   stdout    │                              │
│ transcript.ts records to blocks  │             │ child.ts  bridge extension   │
│ view.ts       window             │ ◀─────────▶ │   main_agent_read            │
│ main-bridge.ts reads and sends   │     IPC     │   main_agent_send            │
│               in the main session│             │   main agent snapshot        │
└──────────────────────────────────┘             └──────────────────────────────┘
```

- The extension starts `pi --mode rpc` with the executable and entry script the
  main pi runs, in the same working directory. The side agent is created when
  you first open the window.
- The window is a pi overlay. It draws the side agent's event stream:
  streamed text, thinking, tool calls, queued messages, and errors.
- `child.ts` is loaded only in the side agent process. Its tools call the main
  process over Node's IPC channel, and `main-bridge.ts` answers from the main
  session with pi's extension API.
- Dialogs that tools in the side agent open (select, confirm, input, editor)
  are shown in the main UI with the prefix `[side agent]`.
- The side session is a normal pi session file under
  `~/.pi/agent/side-agent/sessions/`. The main session records which file
  belongs to it, so the side conversation resumes after `/reload` and when you
  resume the main session.
- When the main pi exits or reloads, the side agent process is told to shut
  down. It also exits by itself when the main process dies.

## Performance

The side agent must not slow the main agent. The design follows from that
requirement:

- The side agent's model calls and tools run in its own process.
- Before you open the window, the extension registers two commands, one
  shortcut, one renderer, and a shutdown hook. It starts no process and
  listens to no session event.
- The main process reads the side agent's stream without parsing records the
  window does not show. A run repeats the whole prompt and tool list three
  times on the wire; those records are dropped by their first bytes.
- A frame that did not change is returned from a cache. A changed frame
  renders only the blocks it shows, and only the block that changed is
  rendered again.
- While the side agent streams, frames are spaced by at least 50 ms and by 50
  times the cost of the last frame. Drawing a streaming answer of 80,000
  characters took 2% of one core. A closed window draws nothing.

The tests check the last four of these properties.

Measured with `npm run bench` on an Apple M5 Pro, Node 24, pi 1.6.1:

| Measurement | Result |
|---|---|
| Load the extension at pi startup | 29 ms to import, 0.3 ms to register |
| Read one run of 5.9 MB (3,000 deltas, 120 tool updates) | 4.1 ms; 0.9 MB parsed |
| Draw an unchanged frame | under 1 µs |
| Draw a frame at the end of a 10-block or 10,000-block transcript | 0.4 to 0.5 ms |
| Draw a frame of a streaming 20,000-character answer | 1.2 ms, one frame per 61 ms |
| Main-process CPU while the side agent streams at 93 records/s, window closed | 1.5% of one core |
| Same, window open | 3.3% of one core |
| Main-process CPU at 873 records/s, window closed / open | 3.9% / 6.5% of one core |
| Event-loop delay while streaming, p99 / max | 2 ms / 8 to 12 ms |
| Event-loop delay of the same process when idle, p99 / max | 1.3 ms / 2.4 ms |
| Side agent start with a 20-package configuration | 2.5 s until ready |
| Side agent memory with that configuration | 400 MB resident |

Three models measured through this extension streamed 31, 51, and 96 text
deltas a second. The 93 records/s rows are therefore the realistic case, and
the 873 records/s row is a stress case. The stream rows use a scripted
provider, so they measure this extension and pi's RPC stream without model
latency.

## Evaluation

`npm run eval` starts the side agent with your pi configuration and a real
model, puts a simulated main agent behind the bridge, and grades each run on
the tools it called and its answer.

| Scenario | Checks |
|---|---|
| `knows-main-task` | Answers what the main agent is doing from the snapshot, without messaging it |
| `reads-main-history` | Calls `main_agent_read` and finds a detail that is only in earlier messages |
| `relays-message` | Sends the user's instruction to a working main agent |
| `asks-and-reports-reply` | Sends with `wait_for_reply` and reports the main agent's answer |
| `no-unprompted-message` | Answers an unrelated question without messaging the main agent |
| `runs-tools` | Runs a shell command and reports its output |
| `web-access` | Uses a web search tool |
| `skills-access` | Names skills from the configured skill set |
| `mcp-access` | Calls an MCP tool |

Results on the author's configuration (pi 1.6.1, 20 packages, 401 skills, an
MCP gateway, models on Amazon Bedrock):

| Model | Scenarios | Passed |
|---|---|---|
| Claude Haiku 5.5, thinking off | all 9, 2 trials | 18 of 18 |
| Claude Fable 5.2, thinking medium | all 9 | 9 of 9 |
| Claude Sonnet 5.5 | the 5 main-agent scenarios | 5 of 5 |
| GPT-6.2 Sol | the 5 main-agent scenarios | 5 of 5 |

In `relays-message` every model chose `follow_up` delivery for "once it
finishes". Pass `--model <provider/id>`, `--thinking <level>`, `--trials <n>`,
and `--only <names>` to `node evals/run.mjs`. The last three scenarios skip
when the configuration has no web, skill, or MCP tools.

## Costs and limits

- The side agent is a second pi process: about 400 MB of memory with a large
  configuration, plus the language servers and MCP servers its extensions
  start. `/quit` stops it.
- Every side agent request carries pi's full system prompt and tool list, as a
  main agent request does. The first request of a side session writes that
  prompt to the provider's cache.
- Both agents work in the same directory. The side agent is told to check for
  collisions before it edits files and to hand changes that belong to the main
  task to the main agent.
- The window is an overlay, so it covers the part of the main transcript
  behind it. Dock it to an edge or close it to see the main transcript.
- pi fixes an overlay's width and position when it is shown. The extension
  reopens the window on those changes; the draft and transcript carry over.
- Extensions in the side agent run in RPC mode. Their dialogs reach you, and
  their custom components and widgets do not.
- The main agent has no tool for writing to the side agent. It replies to a
  waiting side agent in its own transcript, and that reply is relayed.
- If another extension binds `alt+a`, set `toggleKey` to a free key.

## Development

```bash
npm install
npm test            # unit tests, and integration tests against a real pi process with a scripted provider
npm run typecheck
npm run bench       # add `-- --real` to also measure your own pi configuration
npm run eval        # live models; costs tokens
```

The tests start pi from `node_modules` in RPC mode with
`tests/support/scripted-provider.mjs`, so they need no network and no API key.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
