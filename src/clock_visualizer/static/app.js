"use strict";

const $ = id => document.getElementById(id);
const STORAGE_KEY = "logical-clock-workspace-v1";
const clone = value => structuredClone(value);
const fresh = () => ({mode: "lamport", processes: [], events: [], allowInternal: true});
const titles = {lamport: "Lamport clocks", vector: "Vector clocks", modified: "Modified vector clocks"};
const explanations = {
  lamport: ["A scalar clock that respects causal order.", "One counter per process.", "Internal and send events: L ← L + 1. Receive a message timestamped t: L ← max(L, t) + 1. All clocks start at zero. L(a) < L(b) alone does not establish that a caused b."],
  vector: ["Track what each process knows about every other process.", "A vector of causal knowledge.", "Internal and send events on Pi: V[i] ← V[i] + 1. Receive: take the componentwise maximum with the message vector, then increment V[i]. All components start at zero."],
  modified: ["A receive merges knowledge without advancing its own counter.", "Merge on receive. Increment otherwise.", "Internal and send events on Pi: V[i] ← V[i] + 1. Receive a message timestamped t: for every j, V[j] ← max(V[j], t[j]). No increment occurs on receive. All components start at zero."]
};
let state = fresh();
let computed = {events: []};
let history = [];
let busy = true;

function error(message = "") {
  $("error").textContent = message;
  $("error").hidden = !message;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $("status").textContent = "Saved in this browser";
  } catch {
    $("storage-warning").textContent = "Browser storage is unavailable. This workspace will last until you close or refresh the page.";
    $("storage-warning").hidden = false;
    $("status").textContent = "Session only";
  }
}

async function calculate(next) {
  const response = await fetch("/api/calculate", {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(next)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Unable to calculate clocks.");
  return result;
}

async function change(edit, {undo = false} = {}) {
  if (busy) return false;
  busy = true;
  error();
  renderControls();
  try {
    const next = clone(state);
    const candidate = edit(next) || next;
    const result = await calculate(candidate);
    if (undo) history.pop();
    else history.push(clone(state));
    if (history.length > 100) history.shift();
    state = {...candidate, mode: result.mode, processes: result.processes};
    computed = result;
    save();
    render();
    return true;
  } catch (reason) {
    error(reason instanceof TypeError ? "Cannot reach the server. Check that clock-server is still running, then try again." : reason.message);
    return false;
  } finally {
    busy = false;
    renderControls();
  }
}

function options(id, processes, preferred) {
  const select = $(id);
  const old = preferred ?? select.value;
  select.replaceChildren();
  for (const process of processes) {
    const option = document.createElement("option");
    option.value = process.id;
    option.textContent = process.name;
    select.append(option);
  }
  if (processes.some(process => process.id === old)) select.value = old;
  if (!processes.length) {
    const option = document.createElement("option");
    option.textContent = "Add a process first";
    option.value = "";
    select.append(option);
  }
}

function destinations() {
  options("message-to", state.processes.filter(process => process.id !== $("message-from").value));
}

function renderControls() {
  $("mode").value = state.mode;
  $("allow-internal").checked = state.allowInternal;
  options("internal-process", state.processes);
  options("message-from", state.processes);
  destinations();
  $("mode").disabled = busy;
  $("allow-internal").disabled = busy;
  $("process-name").disabled = busy || state.processes.length >= 16;
  $("add-process").disabled = busy || state.processes.length >= 16;
  $("internal-process").disabled = busy || !state.allowInternal || !state.processes.length;
  $("add-internal").disabled = busy || !state.allowInternal || !state.processes.length || state.events.length >= 500;
  $("internal-hint").textContent = state.allowInternal ? "An event visible only to its own process." : "Internal event creation is disabled. Existing events still count.";
  for (const id of ["message-from", "message-to", "send-message"]) $(id).disabled = busy || state.processes.length < 2 || state.events.length > 498;
  $("undo").disabled = busy || !history.length;
  $("reset").disabled = busy || (!state.processes.length && !state.events.length);
  $("example").disabled = busy;
}

const timestamp = value => Array.isArray(value) ? `[${value.join(", ")}]` : String(value);

function svgElement(tag, attributes = {}, text) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderDiagram() {
  const svg = $("timeline");
  svg.replaceChildren();
  $("empty").hidden = state.processes.length > 0;
  svg.toggleAttribute("hidden", !state.processes.length);
  if (!state.processes.length) return;
  const labels = new Map(state.processes.map(process => [process.id, process.name]));
  const rows = new Map(state.processes.map((process, i) => [process.id, 86 + i * 115]));
  const positions = new Map();
  const columns = new Map(state.processes.map(process => [process.id, 0]));
  const longest = Math.max(1, ...computed.events.map(event => timestamp(event.timestamp).length));
  const spacing = Math.max(90, longest * 7.2 + 30);
  for (const event of computed.events) {
    const sender = positions.get(event.send);
    const column = Math.max(columns.get(event.process) + 1, sender ? sender.column + 1 : 1);
    columns.set(event.process, column);
    positions.set(event.id, {column, x: 145 + column * spacing, y: rows.get(event.process)});
  }
  const width = Math.max(760, 220 + (Math.max(1, ...columns.values()) + .6) * spacing);
  const height = Math.max(335, 80 + state.processes.length * 115);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.append(svgElement("title", {id: "svg-title"}, `${titles[state.mode]} execution timeline`));
  svg.append(svgElement("desc", {id: "svg-description"}, "Time moves left to right on each process lane. Arrows connect sends to receives. The event ledger lists all timestamps."));
  const defs = svgElement("defs");
  const marker = svgElement("marker", {id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse"});
  marker.append(svgElement("path", {d: "M 0 0 L 10 5 L 0 10 z", fill: "#176c60"}));
  defs.append(marker);
  svg.append(defs);
  for (const process of state.processes) {
    const y = rows.get(process.id);
    svg.append(svgElement("line", {x1: 145, x2: width - 30, y1: y, y2: y, class: "lane"}));
    const name = process.name.length > 17 ? `${process.name.slice(0, 16)}…` : process.name;
    const label = svgElement("text", {x: 22, y: y + 4, class: "lane-label"}, name);
    label.append(svgElement("title", {}, process.name));
    svg.append(label);
    svg.append(svgElement("text", {x: 145, y: y - 15, class: "lane-initial", "text-anchor": "middle"}, "0"));
  }
  let messageNumber = 0;
  for (const event of computed.events.filter(event => event.kind === "receive")) {
    const from = positions.get(event.send), to = positions.get(event.id);
    const direction = Math.sign(to.y - from.y);
    const number = ++messageNumber;
    svg.append(svgElement("path", {d: `M ${from.x + 5} ${from.y + direction * 8} L ${to.x - 5} ${to.y - direction * 10}`, class: "message-line", "marker-end": "url(#arrow)"}));
    svg.append(svgElement("text", {x: (from.x + to.x) / 2 + 9, y: (from.y + to.y) / 2, class: "message-label"}, `m${number}`));
  }
  computed.events.forEach((event, index) => {
    const {x, y} = positions.get(event.id);
    const group = svgElement("g", {"data-event": event.id});
    group.append(svgElement("title", {}, `e${index + 1}: ${labels.get(event.process)}, ${event.kind}, ${timestamp(event.timestamp)}`));
    const color = {internal: "#617476", send: "#176c60", receive: "#b86436"}[event.kind];
    group.append(svgElement("circle", {cx: x, cy: y, r: 7, fill: color, stroke: "white", "stroke-width": 3}));
    group.append(svgElement("text", {x, y: y - 22, class: "event-label", "text-anchor": "middle"}, timestamp(event.timestamp)));
    group.append(svgElement("text", {x, y: y + 27, class: "event-name", "text-anchor": "middle"}, `e${index + 1}`));
    svg.append(group);
  });
  svg.append(svgElement("text", {x: width - 30, y: height - 20, class: "time-label", "text-anchor": "end"}, "local event order →"));
}

function renderLedger() {
  const rows = $("event-rows");
  rows.replaceChildren();
  const names = new Map(state.processes.map(process => [process.id, process.name]));
  const eventNames = new Map(computed.events.map((event, i) => [event.id, `e${i + 1}`]));
  const receives = new Map(computed.events.filter(event => event.kind === "receive").map(event => [event.send, event.id]));
  for (const event of computed.events) {
    const row = document.createElement("tr");
    const message = event.kind === "receive" ? `from ${eventNames.get(event.send)}` : receives.has(event.id) ? `to ${eventNames.get(receives.get(event.id))}` : "—";
    for (const text of [eventNames.get(event.id), names.get(event.process), event.kind, message, timestamp(event.timestamp)]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    rows.append(row);
  }
  $("ledger-count").textContent = `${computed.events.length} events`;
}

function render() {
  renderControls();
  $("timeline-heading").textContent = titles[state.mode];
  const [summary, title, body] = explanations[state.mode];
  $("mode-summary").textContent = summary;
  $("rule-title").textContent = title;
  $("rule-body").textContent = body;
  $("modified-note").hidden = state.mode !== "modified";
  $("vector-order").textContent = state.mode === "lamport" ? "Send events attach their current clock to the message." : `Vector component order: [${state.processes.map(process => process.name).join(", ")}].`;
  const messages = computed.events.filter(event => event.kind === "receive").length;
  $("stats").textContent = `${state.processes.length} processes · ${computed.events.length} events · ${messages} messages`;
  renderDiagram();
  renderLedger();
}

$("process-form").addEventListener("submit", async event => {
  event.preventDefault();
  const name = $("process-name").value.trim();
  if (await change(next => { next.processes.push({id: crypto.randomUUID(), name}); })) {
    $("process-name").value = "";
    $("process-name").focus();
  }
});
$("internal-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!state.allowInternal || !state.processes.length) return;
  const process = $("internal-process").value;
  change(next => { next.events.push({id: crypto.randomUUID(), process, kind: "internal"}); });
});
$("message-form").addEventListener("submit", event => {
  event.preventDefault();
  const from = $("message-from").value, to = $("message-to").value;
  if (!from || !to || from === to) return;
  change(next => {
    const id = crypto.randomUUID();
    next.events.push({id, process: from, kind: "send"}, {id: crypto.randomUUID(), process: to, kind: "receive", send: id});
  });
});
$("message-from").addEventListener("change", destinations);
$("mode").addEventListener("change", event => {
  const mode = event.target.value;
  change(next => { next.mode = mode; });
});
$("allow-internal").addEventListener("change", event => {
  const enabled = event.target.checked;
  change(next => { next.allowInternal = enabled; });
});
$("undo").addEventListener("click", () => { if (history.length) change(() => clone(history.at(-1)), {undo: true}); });
$("reset").addEventListener("click", () => change(() => ({...fresh(), mode: state.mode, allowInternal: state.allowInternal})));
$("example").addEventListener("click", () => change(() => ({
  mode: state.mode, allowInternal: state.allowInternal,
  processes: [{id: "p1", name: "P1"}, {id: "p2", name: "P2"}, {id: "p3", name: "P3"}],
  events: [
    {id: "a", process: "p1", kind: "internal"},
    {id: "b", process: "p3", kind: "internal"},
    {id: "c", process: "p1", kind: "send"},
    {id: "d", process: "p2", kind: "receive", send: "c"},
    {id: "e", process: "p3", kind: "send"},
    {id: "f", process: "p2", kind: "receive", send: "e"},
    {id: "g", process: "p2", kind: "send"},
    {id: "h", process: "p1", kind: "receive", send: "g"}
  ]
})));

async function start() {
  renderControls();
  let saved;
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) saved = JSON.parse(text);
  } catch {
    error("Could not read the saved workspace. Starting a new session.");
  }
  try {
    if (saved !== undefined) {
      if (!saved || typeof saved.allowInternal !== "boolean") throw new Error("Invalid saved settings.");
      const result = await calculate(saved);
      state = {...saved, mode: result.mode, processes: result.processes};
      computed = result;
      $("status").textContent = "Restored from this browser";
    } else {
      computed = await calculate(state);
      $("status").textContent = "Ready · saved after each edit";
    }
  } catch (reason) {
    error(`Could not restore the workspace: ${reason.message}. You can start a new execution or load the example.`);
    $("status").textContent = "Workspace not restored";
  } finally {
    busy = false;
    render();
  }
}
start();
