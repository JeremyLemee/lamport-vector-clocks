# Logical clock visualizer

## Intent

Build a local educational tool for constructing distributed executions and comparing logical timestamps. The project uses Python and uv and serves its browser GUI on port 8888. The repository currently has no application code.

## Goals

- Create named processes and display each as a horizontal timeline, with time progressing left to right.
- Append internal events to a selected process, or send a message between two distinct processes. Sending creates a send event and a corresponding receive event connected by an arrow.
- Select Lamport clocks (the default), vector clocks, or modified vector clocks; switching modes recomputes labels for the same execution.
- Provide a checkbox to disable adding internal events. Existing events remain in the execution and retain their effect on all clocks.
- Explain each mode's update rules in the GUI and show readable timestamps on every event.
- Supply a small example, undo of the last action, and reset so users can explore and correct an execution.
- Document installation, launch, clock semantics, and automated verification.

## Approaches

The user selected Python with plain JavaScript and SVG. It keeps dependencies and setup small while allowing a clear interactive timeline. Python with React was considered but adds a separate frontend build system without a clear benefit for this scope.

## Architecture

Use Python's standard-library HTTP server to serve bundled HTML, CSS, and JavaScript and a JSON clock calculation endpoint. Package the application with a uv-compatible `pyproject.toml` and a `clock-server` console command. `uv run clock-server` listens on `127.0.0.1:8888` by default; optional host/port arguments are builder choices. There is no Node requirement or frontend compilation step.

The browser maintains the current execution and sends it to the Python clock engine for validation and timestamp computation after edits. Persist the execution in browser local storage so refresh restores the user's work. The server holds no shared mutable execution state; separate browser sessions are independent.

## Execution model

Processes have stable identifiers and display names; their creation order defines vector component order. Events have stable identifiers, a process identifier, an event kind, and, for receives, a reference to an earlier send event. The execution is an ordered list of construction actions. Each message action appends its send event followed by its receive event. This guarantees acyclic causal dependencies and preserves local event order.

Messages are delivered immediately as paired events. Delayed delivery, inserting or moving old events, deleting individual events, separate network simulation, authentication, and multiuser collaboration are outside this version. The timeline still distinguishes causal order from concurrency through clock values; horizontal placement alone does not imply causality across processes.

Adding a process extends all vectors with a zero component when the execution is recomputed. Process names must be nonempty and unique. Messages must connect distinct existing processes. Reject malformed inputs with clear errors. The builder sets reasonable input limits to keep diagrams usable.

## Clock rules

All clocks start at zero. An event's displayed timestamp is the process clock after its update. A send carries its event timestamp.

**Lamport:** internal and send events increment the local scalar by one. A receive with message timestamp t sets the local scalar to `max(local, t) + 1`.

**Vector:** internal and send events increment the process's own component. A receive takes the componentwise maximum of the local vector and the message vector, then increments its own component.

**Modified vector:** internal and send events increment the process's own component. A receive only takes the componentwise maximum of the local vector and the message vector. It does not increment any component. These are the exact rules supplied by the user. The GUI explains that a receive can share a timestamp with its sender or a preceding local event; these timestamps do not uniquely identify events and ordinary strict vector comparison does not recover every happened-before relation in this mode.

The response includes process ordering and timestamps for all events, using arrays for vectors and integers for Lamport timestamps. The engine remains independently testable without HTTP or a browser.

## GUI

One page contains a title and brief purpose, a clock-mode selector, process creation controls, internal-event controls, message source/destination controls, the internal-event toggle, and example/undo/reset actions. An SVG diagram shows labeled process lanes, distinct event markers, message arrows, and timestamp labels. Wide executions scroll horizontally; narrow screens keep controls usable. A small legend explains send, receive, and internal markers. Show empty-state guidance and validation errors inline. Use semantic labels, keyboard-accessible controls, and accessible text describing the diagram's events.

The builder chooses visual styling, spacing, and implementation details. Use no remote assets or services.

## Verification

Test exact clock values for internal events and message chains in all three modes, including merges across multiple processes, consecutive receives without increments in modified mode, and vector expansion after adding processes. Test malformed executions and dangling send references. Test HTTP static serving, valid/invalid calculation requests, and the console launch path. Run available browser smoke checks for process creation, events, messages, mode switching, internal-event disabling, undo, reset, and restoration. If no browser automation is available, record that limitation and verify the API and JavaScript syntax independently.

## Decisions proposed by the builder

Immediate paired delivery, append-only editing with undo/reset, browser-local persistence, standard-library serving, and the interpretation of the internal-event checkbox are proposed defaults rather than additional user requirements.
