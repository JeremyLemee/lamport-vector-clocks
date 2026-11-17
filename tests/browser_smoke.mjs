// Optional browser integration test. Node >=22 and a Chromium executable only;
// no npm dependencies. Run after `uv sync` with CHROMIUM_EXECUTABLE set.
import {spawn} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";

const executable = process.env.CHROMIUM_EXECUTABLE;
assert.ok(executable, "Set CHROMIUM_EXECUTABLE to your Chromium executable.");
const profile = mkdtempSync(join(tmpdir(), "clock-browser-"));
const server = spawn(resolve(".venv/bin/clock-server"), ["--port", "0"], {stdio: ["ignore", "pipe", "pipe"]});
let browser, socket;
const pending = new Map();
let sequence = 0;
const errors = [];

async function waitFor(read, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}

function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, {resolve, reject, timeout});
    socket.send(JSON.stringify({id, method, params}));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const value = id => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
async function idle() {
  await waitFor(() => evaluate('document.readyState === "complete" && document.getElementById("mode")?.disabled === false'), "idle editor");
}
async function click(id) {
  await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  await idle();
}
async function select(id, selected) {
  await evaluate(`(() => {const element = document.getElementById(${JSON.stringify(id)}); element.value = ${JSON.stringify(selected)}; element.dispatchEvent(new Event("change", {bubbles: true}));})()`);
  await idle();
}
async function addProcess(name) {
  await evaluate(`document.getElementById("process-name").value = ${JSON.stringify(name)}`);
  await click("add-process");
}
async function lastStamp() {
  return evaluate('document.querySelector("#event-rows tr:last-child td:last-child").textContent');
}

try {
  let output = "";
  server.stdout.on("data", data => { output += data; });
  server.on("error", error => { errors.push(String(error)); });
  const url = await waitFor(() => output.match(/http:\/\/[^\s]+/)?.[0], "server startup");
  browser = spawn(executable, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {stdio: ["ignore", "ignore", "pipe"]});
  let browserOutput = "";
  browser.stderr.on("data", data => { browserOutput += data; });
  browser.on("error", error => { errors.push(String(error)); });
  const debug = await waitFor(() => {
    if (browser.exitCode !== null || browser.signalCode !== null) throw new Error(`Chromium exited: ${browserOutput}`);
    return browserOutput.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
  }, "Chromium startup");
  const debugUrl = new URL(debug);
  const targets = await (await fetch(`http://${debugUrl.host}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, {once: true}); socket.addEventListener("error", reject, {once: true}); });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const {resolve, reject, timeout} = pending.get(message.id);
      clearTimeout(timeout);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") errors.push(message.params.entry.text);
  });
  await command("Runtime.enable");
  await command("Log.enable");
  await command("Page.enable");
  await command("Page.navigate", {url});
  await idle();
  assert.equal(await evaluate('document.getElementById("mode").value'), "lamport");
  assert.equal(await evaluate('document.getElementById("send-message").disabled'), true);
  // The shortcut fills missing names without replacing existing participants.
  await addProcess("P1");
  await click("quick-processes");
  assert.deepEqual(await evaluate('state.processes.map(p => p.name)'), ["P1", "P2", "P3", "P4"]);
  assert.equal(await evaluate('document.getElementById("quick-processes").disabled'), true);
  await click("undo");
  assert.match(await value("stats"), /^1 processes/);
  await click("quick-processes");
  await select("mode", "vector");
  await click("broadcast-message");
  assert.match(await value("error"), /Choose at least one/);
  await evaluate(`(() => {
    document.querySelector('#broadcast-processes input').checked = true;
    document.getElementById('delay-min').value = '5';
    document.getElementById('delay-max').value = '1';
  })()`);
  await click("broadcast-message");
  assert.match(await value("error"), /minimum ≤ maximum/);
  assert.match(await value("stats"), /0 events/);
  await evaluate(`(() => {
    document.querySelectorAll('#broadcast-processes input').forEach((input, i) => input.checked = i < 2);
    document.getElementById('delay-min').value = '0.2';
    document.getElementById('delay-max').value = '1.2';
    const original = Math.random;
    const samples = [0, .2, .4, .6, .8, .99];
    Math.random = () => samples.shift();
    document.getElementById('broadcast-message').click();
    Math.random = original;
  })()`);
  await waitFor(() => evaluate('state.events.length === 2 && state.pending.length === 6'), "all broadcast sends before any receive");
  assert.deepEqual(await evaluate('computed.events.map(e => e.timestamp)'), [[1, 0, 0, 0], [0, 1, 0, 0]]);
  const delays = await evaluate('state.pending.map(e => e.delaySeconds)');
  assert.equal(new Set(delays).size, 6, "Every recipient has an independent delay");
  assert.ok(delays.every(d => d >= .2 && d <= 1.2));
  assert.equal(await evaluate('new Set([...document.querySelectorAll("#timeline g[data-event] circle")].map(c => c.getAttribute("cx"))).size'), 1, "Simultaneous sends align on the diagram");
  await idle();
  assert.match(await value("stats"), /^4 processes · 8 events · 6 messages$/);
  assert.deepEqual(await evaluate('computed.events.map(e => e.timestamp)'), [[1,0,0,0], [0,1,0,0], [1,2,0,0], [1,0,1,0], [1,0,0,1], [2,1,0,0], [1,1,2,0], [1,1,0,2]]);
  assert.equal(await evaluate('document.querySelectorAll(".message-line").length'), 6);
  assert.match(await value("event-rows"), /0\.20s/);
  await click("undo");
  assert.match(await value("stats"), /^4 processes · 0 events/);
  // Reset cancels pending deliveries, including callbacks already scheduled.
  await evaluate(`document.getElementById('broadcast-message').click()`);
  await waitFor(() => evaluate('state.pending.length === 6 && !busy'), "pending broadcast");
  await click("reset");
  await delay(1300);
  assert.match(await value("stats"), /^0 processes · 0 events/);
  // A refresh resumes the original sampled delays rather than losing receives.
  await click("quick-processes");
  await evaluate(`(() => {
    document.querySelector('#broadcast-processes input').checked = true;
    document.getElementById('delay-min').value = '1';
    document.getElementById('delay-max').value = '1';
    document.getElementById('broadcast-message').click();
  })()`);
  await waitFor(() => evaluate('state.pending.length === 3 && !busy'), "persisted in-flight broadcast");
  await command("Page.reload");
  await waitFor(() => evaluate('document.getElementById("status")?.textContent.includes("Restored")'), "broadcast restoration");
  await idle();
  assert.match(await value("stats"), /^4 processes · 4 events · 3 messages$/);
  // Capacity must include future receives, not only the initial send.
  await evaluate(`change(next => {
    next.events = Array.from({length:497}, (_, i) => ({id:'capacity-'+i, process:next.processes[0].id, kind:'internal'}));
  })`);
  await idle();
  await evaluate(`document.querySelector('#broadcast-processes input').checked = true`);
  await click("broadcast-message");
  assert.match(await value("error"), /500-event limit/);
  assert.match(await value("stats"), /497 events/);
  await click("reset");
  await select("mode", "lamport");
  await addProcess("P1");
  await addProcess("P2");
  assert.match(await value("stats"), /^2 processes/);
  assert.equal(await evaluate('getComputedStyle(document.getElementById("timeline")).display !== "none"'), true, "Timeline must become visible after adding a process");
  await click("add-internal");
  assert.equal(await lastStamp(), "1");
  await click("allow-internal");
  assert.equal(await evaluate('document.getElementById("add-internal").disabled'), true);
  assert.equal(await evaluate('document.querySelectorAll("#event-rows tr").length'), 1);
  await click("send-message");
  assert.equal(await lastStamp(), "3");
  assert.equal(await evaluate('document.querySelectorAll(".message-line").length'), 1);
  await select("mode", "vector");
  assert.equal(await lastStamp(), "[2, 1]");
  await select("mode", "modified");
  assert.equal(await lastStamp(), "[2, 0]");
  await addProcess("P3");
  assert.equal(await lastStamp(), "[2, 0, 0]");
  await click("undo");
  assert.equal(await lastStamp(), "[2, 0]");
  await addProcess("P1");
  assert.equal(await evaluate('document.getElementById("error").hidden'), false);
  assert.match(await value("stats"), /^2 processes/);
  await addProcess("<img src=x onerror=alert(1)>");
  assert.equal(await evaluate('document.querySelectorAll("img").length'), 0, "Process names must render as text");
  await command("Page.reload");
  await waitFor(() => evaluate('document.getElementById("status")?.textContent.includes("Restored")'), "saved workspace restoration");
  assert.equal(await lastStamp(), "[2, 0, 0]");
  assert.equal(await evaluate('document.getElementById("allow-internal").checked'), false);
  await click("reset");
  assert.match(await value("stats"), /^0 processes · 0 events/);
  await click("undo");
  assert.match(await value("stats"), /^3 processes · 3 events/);
  await click("example");
  assert.equal(await lastStamp(), "[2, 1, 2]");
  assert.equal(await evaluate('document.querySelectorAll(".message-line").length'), 3);
  // Long labels and narrow screens must scroll rather than overflow the page.
  for (let i = 4; i <= 16; i++) await addProcess(`P${i}`);
  await select("mode", "vector");
  assert.match(await lastStamp(), /^\[3, 3, 2, 0,/);
  await command("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, "Mobile page must not overflow horizontally");
  await command("Emulation.setDeviceMetricsOverride", {width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false});
  await click("reset");
  await click("example");
  // Exercise invalid persisted data and recovery with a normal editing action.
  await evaluate('localStorage.setItem("logical-clock-workspace-v1", JSON.stringify({allowInternal:true, processes:null, events:[]}))');
  await command("Page.reload");
  await waitFor(() => evaluate('document.getElementById("status")?.textContent === "Workspace not restored"'), "invalid storage validation");
  assert.equal(await evaluate('document.getElementById("error").hidden'), false);
  await click("example");
  assert.equal(await evaluate('document.getElementById("error").hidden'), true);
  // The API defaults a missing mode to Lamport; restoration must use that
  // normalized mode as well, rather than crash while rendering the rules.
  await evaluate('localStorage.setItem("logical-clock-workspace-v1", JSON.stringify({allowInternal:true, processes:[{id:"p",name:"Restored"}], events:[{id:"e",process:"p",kind:"internal"}]}))');
  await command("Page.reload");
  await waitFor(() => evaluate('document.getElementById("status")?.textContent.includes("Restored")'), "saved workspace default mode");
  assert.equal(await lastStamp(), "1", "Saved execution without a mode must restore using Lamport clocks");
  assert.equal(await evaluate('document.getElementById("mode").value'), "lamport");
  await click("example");
  if (process.env.SCREENSHOT_PATH) {
    const screenshot = await command("Page.captureScreenshot", {format: "png"});
    writeFileSync(process.env.SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
  }
  const expectedBadRequests = errors.filter(error => typeof error === "string" && error === "Failed to load resource: the server responded with a status of 400 (Bad Request)");
  assert.equal(expectedBadRequests.length, 2, "Only the duplicate name and corrupt saved execution should return 400");
  assert.deepEqual(errors.filter(error => !expectedBadRequests.includes(error)), [], "No unexpected browser runtime or console errors");
  console.log("Browser smoke passed: quick processes, concurrent broadcasts, independent delays, cancellation, resumed deliveries, event limits, editing, clocks, persistence and mobile layout.");
} finally {
  socket?.close();
  browser?.kill();
  server.kill();
  if (browser) await new Promise(resolve => browser.exitCode !== null || browser.signalCode !== null ? resolve() : browser.once("exit", resolve));
  rmSync(profile, {recursive: true, force: true});
}
