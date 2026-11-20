"use strict";

const $ = id => document.getElementById(id);
const STORAGE_KEY = "logical-clock-workspace-v1";
const clone = value => structuredClone(value);
const fresh = () => ({
  mode: "lamport", processes: [], events: [], allowInternal: true, questionMode: false,
  pending: [], delayMin: 1, delayMax: 5, autoReply: true, replyDelay: 0
});
const titles = {
  lamport: "Lamport clocks", vector: "Vector clocks",
  causal: "Vector clocks for causal ordering"
};
const explanations = {
  lamport: ["A scalar clock that respects causal order.", "One counter per process.", "Internal and send events: L ← L + 1. Receive a message timestamped t: L ← max(L, t) + 1. All clocks start at zero. L(a) < L(b) alone does not establish that a caused b."],
  vector: ["Track what each process knows about every other process.", "A vector of causal knowledge.", "Internal and send events on Pi: V[i] ← V[i] + 1. Receive: take the componentwise maximum with the message vector, then increment V[i]. All components start at zero."],
  causal: [
    "Track which messages each process can deliver in causal order.",
    "Deliver only when the dependencies are ready.",
    "Each process starts with a zero vector and an empty buffer. On broadcast, increment only the sender’s own component and attach the full vector. On arrival, queue the message. For a message with timestamp T from process s and a receiver with clock V, require T[s] = V[s] + 1 and T[k] ≤ V[k] for every k ≠ s. Each delivery merges the timestamp componentwise using max and the receiver checks the buffer again. This model assumes reliable broadcast to the group. Internal events and point-to-point messages leave the causal clock unchanged."
  ]
};
let state = fresh();
let computed = {events: []};
let history = [];
let busy = true;
let deliveryTimer;
let highlightBuffering = false;
const revealed = new Set();
let selectedAnswer = null;
const pendingDeliveries = () => state.pending || [];
const byDeadline = (a, b) => a.deliverAt - b.deliverAt;

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

async function change(edit, {undo = false, recordHistory = true, resetAnswers = false} = {}) {
  if (busy) return false;
  busy = true;
  error();
  renderControls();
  try {
    const next = clone(state);
    const candidate = edit(next) || next;
    const result = await calculate(candidate);
    if (undo) history.pop();
    else if (recordHistory) history.push(clone(state));
    if (history.length > 100) history.shift();
    if (undo || resetAnswers || result.mode !== state.mode || result.processes.length !== state.processes.length) {
      clearAnswers();
    }
    state = {...candidate, mode: result.mode, processes: result.processes, questionMode: state.questionMode};
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
    scheduleDeliveries();
  }
}

function scheduleDeliveries() {
  clearTimeout(deliveryTimer);
  const pending = pendingDeliveries();
  if (!pending.length) return;
  const deadline = Math.min(...pending.map(item => item.deliverAt));
  deliveryTimer = setTimeout(deliverMessages, Math.max(0, deadline - Date.now()));
}

async function deliverMessages() {
  if (busy) {
    deliveryTimer = setTimeout(deliverMessages, 50);
    return;
  }
  const now = Date.now();
  const delivered = await change(next => {
    const due = next.pending.filter(item => item.deliverAt <= now).sort(byDeadline);
    next.events.push(...due.map(({deliverAt, ...event}) => event));
    next.pending = next.pending.filter(item => item.deliverAt > now);
  }, {recordHistory: false});
  // Keep the same scheduled events for retry if the server was unreachable.
  if (!delivered) {
    clearTimeout(deliveryTimer);
    deliveryTimer = setTimeout(deliverMessages, 1000);
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
  const inFlight = pendingDeliveries().length;
  const editingLocked = busy || inFlight > 0;
  $("mode").value = state.mode;
  $("allow-internal").checked = state.allowInternal;
  $("question-mode").checked = state.questionMode;
  $("question-mode").disabled = busy;
  options("internal-process", state.processes);
  options("message-from", state.processes);
  destinations();
  $("mode").disabled = editingLocked;
  $("allow-internal").disabled = editingLocked;
  $("process-name").disabled = editingLocked || state.processes.length >= 16;
  $("add-process").disabled = editingLocked || state.processes.length >= 16;
  const missing = ["P1", "P2", "P3", "P4"].filter(name => !state.processes.some(process => process.name === name));
  $("quick-processes").disabled = editingLocked || !missing.length || state.processes.length + missing.length > 16;
  $("internal-process").disabled = editingLocked || !state.allowInternal || !state.processes.length;
  $("add-internal").disabled = editingLocked || !state.allowInternal || !state.processes.length || state.events.length >= 500;
  $("internal-hint").textContent = state.allowInternal ? "An event visible only to its own process." : "Internal event creation is disabled. Existing events still count.";
  for (const id of ["message-from", "message-to", "send-message"]) $(id).disabled = editingLocked || state.processes.length < 2 || state.events.length > 498;
  const senderList = $("broadcast-processes");
  const selected = new Set([...senderList.querySelectorAll("input:checked")].map(input => input.value));
  senderList.replaceChildren();
  for (const process of state.processes) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = process.id;
    input.checked = selected.has(process.id);
    label.append(input, document.createTextNode(process.name));
    senderList.append(label);
  }
  if (!state.processes.length) senderList.textContent = "Add processes to choose senders.";
  $("broadcast-senders").disabled = editingLocked || state.processes.length < 2;
  for (const id of ["delay-min", "delay-max", "broadcast-message", "auto-reply"]) $(id).disabled = editingLocked || state.processes.length < 2;
  $("auto-reply").checked = state.autoReply;
  $("reply-delay").disabled = $("auto-reply").disabled || !state.autoReply;
  $("broadcast-status").textContent = inFlight ? "Messages in flight. Undo or reset cancels pending events." : "No messages in flight.";
  $("buffering-controls").hidden = state.mode !== "causal";
  $("highlight-buffering").disabled = !computed.events.some(event => event.delivery);
  $("undo").disabled = busy || !history.length;
  $("reset").disabled = busy || (!state.processes.length && !state.events.length);
  $("example").disabled = busy;
}

const timestamp = value => Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
const deliveryVector = ({delivered, vector}) => delivered.map((count, i) => Math.max(count, vector[i]));

function eventTimestamp(event) {
  return event.delivery?.failures.length
    ? `${timestamp(deliveryVector(event.delivery))} (expected)`
    : timestamp(event.timestamp);
}

const displayedTimestamp = event => state.questionMode && !revealed.has(event.id) ? "?" : eventTimestamp(event);
const answerLabel = (name, stamp) => stamp === "?" ? `Show answer for ${name}` : `Show calculation for ${name}, ${stamp}`;

function renderBuffering() {
  if (state.mode !== "causal") highlightBuffering = false;
  $("highlight-buffering").setAttribute("aria-pressed", String(highlightBuffering));
  const status = $("buffering-status");
  status.hidden = !highlightBuffering;
  const count = computed.events.filter(event => event.delivery?.failures.length).length;
  status.textContent = count
    ? `${count} ${count === 1 ? "receive would wait" : "receives would wait"} for an earlier message.`
    : "No received messages would need buffering.";
}

function bufferingExplanation({failures, vector, delivered}) {
  const blockers = failures.flatMap(failure => failure.blockers).map(id =>
    `e${computed.events.findIndex(event => event.id === id) + 1}`
  );
  const reason = blockers.length ? `Would buffer · waiting for ${blockers.join(", ")}` : "Would buffer";
  const comparisons = failures.map(({source, isSender, count, deliveredCount}) => {
    const name = state.processes[source].name;
    const comparison = isSender
      ? `${name} (sender): sequence ${count}, expected ${deliveredCount + 1} (${deliveredCount} + 1)`
      : `${name} (dependency): ${count} > ${deliveredCount} delivered`;
    const missing = count - deliveredCount - Number(isSender);
    return missing > 0
      ? `${comparison}. Missing ${missing} ${missing === 1 ? "message" : "messages"} from ${name}.`
      : comparison;
  });
  return [reason, `Message vector ${timestamp(vector)}`, `Receiver vector ${timestamp(delivered)}`, ...comparisons].join(" · ");
}

function bufferLabel(event) {
  return highlightBuffering && event.delivery?.failures.length ? bufferingExplanation(event.delivery) : "";
}

function clearAnswers() {
  revealed.clear();
  selectedAnswer = null;
}

function renderDeduction() {
  const index = computed.events.findIndex(event => event.id === selectedAnswer);
  $("deduction").hidden = !state.questionMode || index < 0;
  if ($("deduction").hidden) return;

  const event = computed.events[index];
  const processIndex = state.processes.findIndex(process => process.id === event.process);
  const process = state.processes[processIndex];
  const previousIndex = computed.events.findLastIndex((prior, i) => i < index && prior.process === event.process);
  const sendIndex = computed.events.findIndex(prior => prior.id === event.send);
  const prior = computed.events[previousIndex];
  const before = prior ? prior.timestamp : state.mode === "lamport" ? 0 : Array(state.processes.length).fill(0);
  const incoming = computed.events[sendIndex]?.timestamp;
  const after = timestamp(event.timestamp);
  const component = `V[${processIndex + 1}] (${process.name})`;
  $("deduction-title").textContent = `e${index + 1} · ${process.name} · ${event.kind}`;
  $("deduction-before").textContent = `${timestamp(before)} (${previousIndex < 0 ? "initial clock" : `after e${previousIndex + 1}`})`;
  if (state.mode === "causal") {
    const detail = event.delivery;
    let result = `Vector stays at ${after}.`;
    if (event.broadcast) {
      $("deduction-info").textContent = `This broadcast carries ${after} to every recipient.`;
      result = `Increment ${component} from ${before[processIndex]} to ${event.timestamp[processIndex]} → ${after}.`;
    } else if (detail) {
      $("deduction-info").textContent = `Message from e${sendIndex + 1} carries ${timestamp(detail.vector)}.`;
      if (detail.failures.length) {
        result = `${bufferingExplanation(detail)}. Expected vector ${timestamp(deliveryVector(detail))} after merging. The delivered clock stays at ${after} at this arrival.`;
      } else {
        result = `Delivery checks pass. Merge componentwise using max → ${timestamp(deliveryVector(detail))}.`;
        if (detail.released) {
          result += ` Released ${detail.released} buffered ${detail.released === 1 ? "message" : "messages"} → ${after}.`;
        }
      }
    } else {
      $("deduction-info").textContent = "Only broadcasts and their delivery update this clock.";
    }
    $("deduction-result").textContent = result;
    return;
  }
  let calculation;
  if (state.mode === "lamport") {
    calculation = incoming === undefined ? `${before} + 1 = ${after}` : `max(${before}, ${incoming}) + 1 = ${after}`;
  } else if (incoming === undefined) {
    calculation = `Increment ${component} from ${before[processIndex]} to ${event.timestamp[processIndex]} → ${after}`;
  } else {
    const merged = before.map((value, i) => Math.max(value, incoming[i]));
    calculation = `Componentwise max → ${timestamp(merged)}`;
    calculation += `, then increment ${component} from ${merged[processIndex]} to ${event.timestamp[processIndex]} → ${after}`;
  }

  $("deduction-info").textContent = incoming === undefined
    ? (event.kind === "send" ? "A send event advances the local clock and carries the new value." : "An internal event advances the local clock.")
    : `Message from e${sendIndex + 1} carries ${timestamp(incoming)}.`;
  $("deduction-result").textContent = calculation;
}

function showAnswer(id) {
  if (!state.questionMode) return;
  revealed.add(id);
  selectedAnswer = id;
  renderDiagram();
  renderLedger();
  renderDeduction();
  $("deduction-title").focus({preventScroll: true});
  $("deduction").scrollIntoView({block: "nearest"});
}

function svgElement(tag, attributes = {}, text) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderDiagram() {
  const svg = $("timeline");
  svg.replaceChildren();
  svg.setAttribute("role", state.questionMode ? "group" : "img");
  $("empty").hidden = state.processes.length > 0;
  svg.toggleAttribute("hidden", !state.processes.length);
  if (!state.processes.length) return;
  const labels = new Map(state.processes.map(process => [process.id, process.name]));
  const rows = new Map(state.processes.map((process, i) => [process.id, 86 + i * 115]));
  const positions = new Map();
  const columns = new Map(state.processes.map(process => [process.id, 0]));
  const longest = Math.max(1, ...computed.events.map(event => eventTimestamp(event).length));
  const spacing = Math.max(90, longest * 7.2 + 30);
  const batches = new Map();
  const metadata = new Map(state.events.map(event => [event.id, event]));
  for (const event of computed.events) {
    const sender = positions.get(event.send);
    const batch = metadata.get(event.id)?.batch;
    if (batch && !batches.has(batch)) batches.set(batch, Math.max(0, ...columns.values()) + 1);
    const column = Math.max(columns.get(event.process) + 1, sender ? sender.column + 1 : 1, batch ? batches.get(batch) : 1);
    columns.set(event.process, column);
    positions.set(event.id, {column, x: 145 + column * spacing, y: rows.get(event.process)});
  }
  const width = Math.max(760, 220 + (Math.max(1, ...columns.values()) + .6) * spacing);
  const height = Math.max(335, 80 + state.processes.length * 115);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.append(svgElement("title", {id: "svg-title"}, `${titles[state.mode]} execution timeline`));
  svg.append(svgElement("desc", {id: "svg-description"}, "Time moves left to right on each process lane. Arrows connect sends to receives. Timestamps are also available in the event ledger."));
  const defs = svgElement("defs");
  const marker = svgElement("marker", {id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse"});
  marker.append(svgElement("path", {d: "M 0 0 L 10 5 L 0 10 z", fill: "#176c60"}));
  defs.append(marker);
  const bufferedMarker = marker.cloneNode(true);
  bufferedMarker.id = "buffered-arrow";
  bufferedMarker.firstChild.setAttribute("fill", "#993f2e");
  defs.append(bufferedMarker);
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
  const broadcastSends = new Set(computed.events.filter(event => event.broadcast).map(event => event.id));
  for (const event of computed.events.filter(event => event.kind === "receive")) {
    const from = positions.get(event.send), to = positions.get(event.id);
    const direction = Math.sign(to.y - from.y);
    const number = ++messageNumber;
    const buffered = highlightBuffering && Boolean(event.delivery?.failures.length);
    const startX = from.x + 5, startY = from.y + direction * 8;
    const endX = to.x - 5, endY = to.y - direction * 10;
    const midX = (startX + endX) / 2, midY = (startY + endY) / 2;
    // Bow broadcast arrows in their direction of travel so reciprocal arrows
    // have separate midpoints and fan-out arrows diverge across the lanes.
    const bend = broadcastSends.has(event.send) ? direction * 36 : 0;
    const path = bend ? `Q ${midX + bend} ${midY} ${endX} ${endY}` : `L ${endX} ${endY}`;
    svg.append(svgElement("path", {
      d: `M ${startX} ${startY} ${path}`,
      class: buffered ? "message-line needs-buffering" : "message-line",
      "marker-end": buffered ? "url(#buffered-arrow)" : "url(#arrow)"
    }));
    svg.append(svgElement("text", {x: midX + bend / 2 + 9, y: midY, class: "message-label"}, `m${number}`));
  }
  computed.events.forEach((event, index) => {
    const {x, y} = positions.get(event.id);
    const name = `e${index + 1}`;
    const stamp = displayedTimestamp(event);
    const group = svgElement("g", {"data-event": event.id});
    const buffer = bufferLabel(event);
    const isReply = Boolean(metadata.get(event.id)?.replyTo);
    const type = isReply ? "broadcast reply" : event.kind;
    group.append(svgElement("title", {}, [`${name}: ${labels.get(event.process)}, ${type}, ${stamp}`, buffer].filter(Boolean).join(" · ")));
    if (state.questionMode) {
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute("class", "question-event");
      group.setAttribute("aria-label", [answerLabel(`${name} on ${labels.get(event.process)}`, stamp), buffer].filter(Boolean).join(". "));
      const hitWidth = Math.max(44, stamp.length * 7.2 + 12);
      group.append(svgElement("rect", {x: x - hitWidth / 2, y: y - 39, width: hitWidth, height: 73, rx: 6, class: "event-hit"}));
      group.addEventListener("click", () => showAnswer(event.id));
      group.addEventListener("keydown", key => {
        if (key.key !== "Enter" && key.key !== " ") return;
        key.preventDefault();
        showAnswer(event.id);
      });
    }
    if (buffer) {
      group.classList.add("needs-buffering");
      group.append(svgElement("circle", {cx: x, cy: y, r: 12, class: "buffering-ring"}));
    }
    const color = {internal: "#617476", send: "#176c60", receive: "#b86436"}[event.kind];
    group.append(svgElement("circle", {cx: x, cy: y, r: 7, fill: color, stroke: "white", "stroke-width": 3}));
    group.append(svgElement("text", {x, y: y - 22, class: "event-label", "text-anchor": "middle"}, stamp));
    group.append(svgElement("text", {x, y: y + 27, class: "event-name", "text-anchor": "middle"}, isReply ? `${name} · reply` : name));
    svg.append(group);
  });
  svg.append(svgElement("text", {x: width - 30, y: height - 20, class: "time-label", "text-anchor": "end"}, "local event order →"));
}

function renderLedger() {
  const rows = $("event-rows");
  rows.replaceChildren();
  const names = new Map(state.processes.map(process => [process.id, process.name]));
  const eventNames = new Map(computed.events.map((event, i) => [event.id, `e${i + 1}`]));
  const receives = new Map();
  const metadata = new Map(state.events.map(event => [event.id, event]));
  for (const event of computed.events.filter(event => event.kind === "receive")) {
    if (!receives.has(event.send)) receives.set(event.send, []);
    receives.get(event.send).push(eventNames.get(event.id));
  }
  for (const event of computed.events) {
    const row = document.createElement("tr");
    const replyTo = metadata.get(event.id)?.replyTo;
    const message = event.kind === "receive"
      ? `from ${eventNames.get(event.send)}`
      : receives.has(event.id) ? `to ${receives.get(event.id).join(", ")}` : "—";
    const name = eventNames.get(event.id);
    const type = replyTo ? "broadcast reply" : event.broadcast ? "broadcast send" : event.kind;
    const buffer = bufferLabel(event);
    if (buffer) row.classList.add("needs-buffering");
    const details = [replyTo && `reply to ${eventNames.get(replyTo)}`, message].filter(Boolean).join(" · ");
    for (const text of [name, names.get(event.process), type, details]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    if (buffer) {
      const explanation = document.createElement("span");
      explanation.className = "buffering-explanation";
      explanation.textContent = buffer;
      row.lastChild.append(explanation);
    }
    const stampCell = document.createElement("td");
    const stamp = displayedTimestamp(event);
    if (state.questionMode) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stamp-button";
      button.textContent = stamp;
      button.setAttribute("aria-label", answerLabel(name, stamp));
      button.addEventListener("click", () => showAnswer(event.id));
      stampCell.append(button);
    } else {
      stampCell.textContent = stamp;
    }
    row.append(stampCell);
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
  $("message-hint").textContent = state.mode === "causal"
    ? "Point-to-point messages leave the causal clock unchanged. Use Broadcast together to advance it."
    : "Adds a send and a receive together. Delivery is immediate.";
  $("vector-order").textContent = state.mode === "lamport" ? "Send events attach their current clock to the message." : `Vector component order: [${state.processes.map(process => process.name).join(", ")}].`;
  const messages = computed.events.filter(event => event.kind === "receive").length;
  $("stats").textContent = `${state.processes.length} processes · ${computed.events.length} events · ${messages} messages`;
  $("question-hint").hidden = !state.questionMode || !computed.events.length;
  $("ledger-clock-heading").textContent = state.mode === "causal" ? "Causal vector" : "Timestamp";
  renderBuffering();
  renderDiagram();
  renderLedger();
  renderDeduction();
}

$("process-form").addEventListener("submit", async event => {
  event.preventDefault();
  const name = $("process-name").value.trim();
  if (await change(next => { next.processes.push({id: crypto.randomUUID(), name}); })) {
    $("process-name").value = "";
    $("process-name").focus();
  }
});
$("quick-processes").addEventListener("click", () => change(next => {
  const missing = ["P1", "P2", "P3", "P4"].filter(name => !next.processes.some(process => process.name === name));
  if (next.processes.length + missing.length > 16) throw new Error("There is not enough room to add P1–P4.");
  next.processes.push(...missing.map(name => ({id: crypto.randomUUID(), name})));
}));

function scheduleReceives(send, recipients, sentAt, min, max) {
  return recipients.map(process => {
    const delaySeconds = min + Math.random() * (max - min);
    return {
      id: crypto.randomUUID(), process, kind: "receive", send, delaySeconds,
      deliverAt: sentAt + delaySeconds * 1000
    };
  });
}

$("broadcast-form").addEventListener("submit", event => {
  event.preventDefault();
  if (busy || pendingDeliveries().length) return;
  const senders = [...$("broadcast-processes").querySelectorAll("input:checked")].map(input => input.value);
  const min = $("delay-min").valueAsNumber, max = $("delay-max").valueAsNumber;
  const {autoReply} = state;
  const replyDelay = $("reply-delay").valueAsNumber;
  if (!senders.length) return error("Choose at least one broadcast sender.");
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0.01 || max > 3600 || min > max) {
    return error("Choose a delay interval from 0.01 to 3600 seconds, with minimum ≤ maximum.");
  }
  if (autoReply && (!Number.isFinite(replyDelay) || replyDelay < 0 || replyDelay > 2)) {
    return error("Choose a reply wait from 0 to 2 seconds.");
  }
  const eventCount = senders.length * state.processes.length * (autoReply ? 2 : 1);
  if (state.events.length + eventCount > 500) {
    return error("This broadcast would exceed the 500-event limit. Choose fewer senders or reset the execution.");
  }
  const started = Date.now();
  const batch = crypto.randomUUID();
  change(next => {
    next.delayMin = min;
    next.delayMax = max;
    if (autoReply) next.replyDelay = replyDelay;
    const processes = next.processes.map(process => process.id);
    const replies = [];
    for (const process of senders) {
      const id = crypto.randomUUID();
      next.events.push({id, process, kind: "send", broadcast: true, batch});
      const arrivals = scheduleReceives(id, processes.filter(recipient => recipient !== process), started, min, max);
      next.pending.push(...arrivals);
      if (autoReply) {
        // Stable order breaks equal deadlines by the original recipient order.
        const first = arrivals.sort(byDeadline)[0];
        replies.push({
          id: crypto.randomUUID(), process: first.process, kind: "send",
          broadcast: true, replyTo: id, deliverAt: first.deliverAt + replyDelay * 1000
        });
      }
    }
    // Append replies after all original arrivals so a zero-wait reply follows its receive.
    for (const reply of replies) {
      const recipients = processes.filter(process => process !== reply.process);
      next.pending.push(reply, ...scheduleReceives(reply.id, recipients, reply.deliverAt, min, max));
    }
  });
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
$("auto-reply").addEventListener("change", event => {
  state.autoReply = event.target.checked;
  $("reply-delay").disabled = !state.autoReply;
  save();
});
$("highlight-buffering").addEventListener("click", () => {
  highlightBuffering = !highlightBuffering;
  renderBuffering();
  renderDiagram();
  renderLedger();
});
$("mode").addEventListener("change", event => {
  const mode = event.target.value;
  change(next => { next.mode = mode; });
});
$("allow-internal").addEventListener("change", event => {
  const enabled = event.target.checked;
  change(next => { next.allowInternal = enabled; });
});
$("question-mode").addEventListener("change", event => {
  state.questionMode = event.target.checked;
  clearAnswers();
  save();
  render();
});
$("undo").addEventListener("click", () => { if (history.length) change(() => clone(history.at(-1)), {undo: true}); });
$("reset").addEventListener("click", () => change(() => ({
  ...fresh(), mode: state.mode, allowInternal: state.allowInternal,
  autoReply: state.autoReply, replyDelay: state.replyDelay
}), {resetAnswers: true}));
$("example").addEventListener("click", () => change(() => ({
  ...fresh(), mode: state.mode, allowInternal: state.allowInternal,
  autoReply: state.autoReply, replyDelay: state.replyDelay,
  processes: [{id: "p1", name: "P1"}, {id: "p2", name: "P2"}, {id: "p3", name: "P3"}],
  events: state.mode === "causal" ? [
    {id: "alice", process: "p1", kind: "send", broadcast: true},
    {id: "bob-receives", process: "p2", kind: "receive", send: "alice"},
    {id: "bob", process: "p2", kind: "send", broadcast: true, replyTo: "alice"},
    {id: "john-early", process: "p3", kind: "receive", send: "bob"},
    {id: "alice-receives", process: "p1", kind: "receive", send: "bob"},
    {id: "john-late", process: "p3", kind: "receive", send: "alice"}
  ] : [
    {id: "a", process: "p1", kind: "internal"},
    {id: "b", process: "p3", kind: "internal"},
    {id: "c", process: "p1", kind: "send"},
    {id: "d", process: "p2", kind: "receive", send: "c"},
    {id: "e", process: "p3", kind: "send"},
    {id: "f", process: "p2", kind: "receive", send: "e"},
    {id: "g", process: "p2", kind: "send"},
    {id: "h", process: "p1", kind: "receive", send: "g"}
  ]
}), {resetAnswers: true}));

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
      if (saved.mode === "modified") saved.mode = "causal";
      const pending = saved.pending ?? [];
      if (!Array.isArray(pending) || pending.some(item => !item || !Number.isFinite(item.deliverAt) ||
        (item.kind === "send" ? item.broadcast !== true || typeof item.replyTo !== "string" :
          item.kind !== "receive" || !Number.isFinite(item.delaySeconds) || item.delaySeconds < 0.01 || item.delaySeconds > 3600))) {
        throw new Error("Invalid pending deliveries.");
      }
      // Validate future deliveries too, before resuming a restored broadcast.
      if (pending.length) await calculate({...saved, events: [...saved.events, ...[...pending].sort(byDeadline)]});
      const result = await calculate(saved);
      state = {...fresh(), ...saved, pending, mode: result.mode, processes: result.processes, questionMode: saved.questionMode === true};
      computed = result;
      $("delay-min").value = state.delayMin;
      $("delay-max").value = state.delayMax;
      $("reply-delay").value = state.replyDelay;
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
    scheduleDeliveries();
  }
}
start();
