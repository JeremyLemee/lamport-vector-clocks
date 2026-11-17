# Logical Clock Visualizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a uv Python project serving an interactive logical clock editor on port 8888.

**Architecture:** A pure Python calculation engine validates executions; a standard-library HTTP server serves static assets and JSON calculations. The browser owns editing and persistence and renders SVG timelines.

**Tech Stack:** Python >=3.11, uv, standard-library unittest and HTTP server, JavaScript, CSS, SVG.

**Spec:** `docs/superpowers/specs/2026-11-11-clock-visualizer-design.md`

## Global Constraints

- Default port 8888, default host 127.0.0.1; default mode Lamport.
- No Node requirement or frontend compilation step; no remote assets or services.
- Modified vector receives merge only, with no increment.
- Internal-event checkbox prevents additions, preserves existing events.

## Review Focus

- Invalid imported or persisted executions must fail visibly without corrupting the editor.
- Rapid edits must not display stale calculation results.
- User names must render as text, including HTML-like strings.
- Large diagrams must scroll and keep vector labels readable.
- Malformed request bodies and send references must return clear validation errors.

### Task 1: Clock engine and package

**Files:** `pyproject.toml`, `src/clock_visualizer/__init__.py`, `src/clock_visualizer/clocks.py`, `tests/test_clocks.py`.

**Interfaces:** `calculate(payload: dict) -> dict` consumes `{processes: [{id,name}], events: [{id,process,kind,send?}], mode}`; returns `{mode, processes, events}` with timestamps attached to copied events. Invalid input raises ValueError.

- [x] Write hand-computed tests for three-mode message chains, consecutive receives, independent processes, added vector components and invalid inputs.
- [x] Run `python3 -m unittest discover -s tests -v` and observe missing engine failure.
- [x] Implement validation, snapshots and scalar/vector clock rules.
- [x] Run the whole suite; expect all tests passing.

### Task 2: HTTP transport and launch

**Files:** `src/clock_visualizer/server.py`, `src/clock_visualizer/__main__.py`, `tests/test_server.py`.

**Interfaces:** `create_server(host='127.0.0.1', port=8888) -> ThreadingHTTPServer`; `main()` CLI. POST `/api/calculate` consumes engine payloads and returns engine result or JSON error. GET serves only bundled assets.

- [x] Write live HTTP tests for calculations, invalid JSON and payloads, request size, unknown routes and asset serving.
- [x] Run suite and observe missing server failure.
- [x] Implement resource loading, JSON handling, safe static routes and CLI.
- [x] Run full suite and CLI help; expect pass and documented defaults.

### Task 3: Editor and documentation

**Files:** `src/clock_visualizer/static/{index.html,app.js,style.css}`, `README.md`, `.gitignore`, `uv.lock`.

**Interfaces:** Browser posts Task 1's payloads to Task 2's endpoint. Process/event identifiers use UUIDs. SVG and event table share server-calculated labels. UI state updates only on successful calculation; edits are serialized.

- [x] Prepare browser smoke assertions for process creation, internal toggle, messages, mode switching, undo, reset and persistence; run against missing assets to observe failure if browser tooling is available.
- [x] Implement accessible responsive editor, SVG timeline, rules, event table, storage and example.
- [x] Document uv launch, semantics, controls, limits and test commands.
- [x] Run suite, JavaScript syntax check, uv build/launch and available browser smoke checks.
- [x] Request independent review and resolve substantive findings with regression tests.

## Execution record

- User approved design and explicitly requested implementation; execute inline without further approval gates.
- Empty unborn repository: implement in the supplied checkout; no existing code or test baseline.
- Preserve changes for user review without creating commits or publishing.
- Task 1: five unittest cases passing, including table-driven three-mode calculations and malformed execution subcases.
- Task 2: four live HTTP unittest cases passing; uv installation, CLI help and package build verified.
- Task 3: real Chromium smoke passed editing, clocks, storage, validation, HTML-like names, vector expansion and mobile layout. It exposed SVG hidden-attribute reflection and a favicon CSP mismatch; both reproduced and fixed.
- Independent code review found one substantive issue: missing mode in an otherwise valid saved execution. A new browser case reproduced the failure; restoration now uses the server-normalized mode. Final full Python suite (9 tests), complete browser smoke, both JavaScript syntax checks and uv build all passed. No substantive review findings remain.
