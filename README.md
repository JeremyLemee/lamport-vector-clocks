# Logical clock visualizer

A local, interactive distributed systems lab built with Python, uv, plain JavaScript and SVG. No runtime dependencies, JavaScript build tools, or external assets.

## Run

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then from this directory:

```bash
uv run clock-server
```

Open **http://localhost:8888**. Stop with Ctrl+C. Python 3.11 or newer is supported. uv creates the environment and installs the package on first launch; that initial build may need internet access to fetch the build backend.

```bash
uv run clock-server --host 127.0.0.1 --port 8888
uv run python -m clock_visualizer
```

## Use

- Add named processes; their creation order defines vector component order.
- **Create P1–P4** adds any missing processes with those names in one click, preserving your existing work.
- Add internal events to a selected process. Uncheck **Allow internal events** to disable new internal events; existing events still affect clocks.
- Select distinct source and destination processes and send a message. This adds a send and its receive together with immediate delivery.
- For a **broadcast**, select one or more senders and choose minimum and maximum delivery delays (default 1–5 seconds; customizable from 0.01 to 3600 seconds). **Broadcast together** creates one send event per selected sender at the same start time. Each sends to every other process with an independently sampled uniform random delay. Receives appear live in delivery order; arrows and ledger entries show the sampled delays. These physical delays do not advance logical clocks by seconds.
- While broadcasts are in flight, editing pauses. **Undo** removes the entire broadcast batch and **Reset** clears the workspace, canceling pending deliveries. Refreshing resumes saved deliveries with their original deadlines. The server must remain available for deliveries to appear; delayed browser timers may display them late, but their sampled order is preserved.
- Switch the clock model to relabel the same execution. Lamport is the default for new workspaces.
- **Load example** demonstrates a three-process execution. **Undo** reverses the latest change (including messages, settings, example loading, and reset). The most recent 100 actions are available until refresh.
- **Reset** clears the execution and processes; it preserves clock mode and the internal-event setting.
- The workspace is saved in this browser automatically. Refresh restores it; browser tabs hold independent live editors, and the most recently saved tab supplies the next restored session. Undo history is not saved.
- Scroll wide diagrams horizontally, or expand the event ledger for accessible tabular timestamps. Event names e1, e2, … follow construction order. Only local lane order and message arrows imply causality; horizontal alignment across processes does not.

This version supports up to 16 processes and 500 events, including reserved pending broadcast receives. Editing is append-only with undo/reset. Inserting events into existing timelines and moving events are outside its scope. Loading the example replaces the execution with its bundled events even when internal-event creation is disabled.

## Clock rules

All clocks start at zero. Each label is the clock **after** that event. Sends carry their event's timestamp. A message action creates two events.

| Model | Internal or send on Pi | Receive on Pi, with timestamp t |
| --- | --- | --- |
| Lamport (default) | `L = L + 1` | `L = max(L, t) + 1` |
| Vector | `V[i] = V[i] + 1` | Componentwise `V[j] = max(V[j], t[j])`, then `V[i] += 1` |
| Modified vector | `V[i] = V[i] + 1` | Componentwise `V[j] = max(V[j], t[j])`; **no increment** |

Standard vector clocks distinguish concurrent events: neither vector is componentwise less than or equal to the other. Modified vector clocks follow the supplied rule exactly, so a receive can share a timestamp with its sender or a preceding local event. Strict vector comparison therefore does not recover every happened-before relation in that mode. Timestamps are not event identifiers.

Adding another process recomputes vectors with an additional zero component for earlier events.

## Development and verification

```bash
uv run python -m unittest discover -s tests -v
node --check src/clock_visualizer/static/app.js
uv build
```

The Python suite exercises hand-calculated message chains in all modes, vector expansion, independent events, invalid executions, the HTTP calculation endpoint and static serving. Tests use standard-library unittest and actual HTTP requests on an ephemeral localhost port. Node is optional and used only for development checks.

An optional real-browser smoke test requires Node 22+ and a Chromium executable, with no npm dependencies:

```bash
CHROMIUM_EXECUTABLE=/path/to/chromium node tests/browser_smoke.mjs
```

It starts a temporary local server and browser profile, exercises editing, mode switching, messages, the internal-event toggle, undo/reset, saved-session restoration, invalid saved data, safe rendering of names, long vectors and mobile layout, then closes both processes. Set `SCREENSHOT_PATH=/tmp/clocks.png` to save a screenshot.

The server is intended for local educational use and binds to loopback by default. `POST /api/calculate` accepts `{mode, processes: [{id, name}], events: [{id, process, kind, send?, broadcast?}]}` and returns normalized processes and event timestamps. Receive references must point to earlier sends on distinct processes; ordinary sends support one receiver, while sends with `broadcast: true` support one receive per other process. Errors return JSON with an `error` string. Requests are limited to 256 KiB.
