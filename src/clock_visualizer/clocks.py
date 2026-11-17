"""Validation and timestamp computation, independent of the HTTP transport."""

MODES = {"lamport", "vector", "modified"}
MAX_PROCESSES = 16
MAX_EVENTS = 500


def _text(value, label, limit=80):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"{label} must be nonempty text of at most {limit} characters.")
    return value.strip()


def calculate(payload: dict) -> dict:
    """Return event clock snapshots for an execution, without mutating input.

    Events are topologically ordered: each receive references a prior send.
    A send has at most one receiver. Vector components follow process order.
    """
    if not isinstance(payload, dict):
        raise ValueError("The execution must be a JSON object.")
    mode = payload.get("mode", "lamport")
    if not isinstance(mode, str) or mode not in MODES:
        raise ValueError("Choose lamport, vector, or modified clocks.")
    processes, events = payload.get("processes"), payload.get("events")
    if not isinstance(processes, list) or len(processes) > MAX_PROCESSES:
        raise ValueError(f"Provide a list of at most {MAX_PROCESSES} processes.")
    if not isinstance(events, list) or len(events) > MAX_EVENTS:
        raise ValueError(f"Provide a list of at most {MAX_EVENTS} events.")
    indices, names, normalized = {}, set(), []
    for process in processes:
        if not isinstance(process, dict):
            raise ValueError("Each process must be an object.")
        identifier = _text(process.get("id"), "Process ID")
        name = _text(process.get("name"), "Process name", 32)
        if identifier in indices or name in names:
            raise ValueError("Process IDs and names must be unique.")
        indices[identifier] = len(indices)
        names.add(name)
        normalized.append({"id": identifier, "name": name})
    clocks = [0 if mode == "lamport" else [0] * len(indices) for _ in indices]
    seen, received, result = {}, set(), []
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("Each event must be an object.")
        identifier = _text(event.get("id"), "Event ID")
        process = _text(event.get("process"), "Event process")
        kind = event.get("kind")
        if identifier in seen:
            raise ValueError("Event IDs must be unique.")
        if process not in indices:
            raise ValueError("Every event must belong to an existing process.")
        if kind not in ("internal", "send", "receive"):
            raise ValueError("Event kind must be internal, send, or receive.")
        i = indices[process]
        output = {"id": identifier, "process": process, "kind": kind}
        incoming = None
        if kind == "receive":
            send_id = _text(event.get("send"), "Referenced send ID")
            sender = seen.get(send_id)
            if sender is None or sender["kind"] != "send":
                raise ValueError("A receive must reference an earlier send event.")
            if sender["process"] == process:
                raise ValueError("Messages must connect distinct processes.")
            if send_id in received:
                raise ValueError("A send event can have only one receiver.")
            received.add(send_id)
            output["send"] = send_id
            incoming = sender["timestamp"]
        if mode == "lamport":
            clocks[i] = max(clocks[i], incoming or 0) + 1
            output["timestamp"] = clocks[i]
        else:
            if incoming is not None:
                clocks[i] = [max(local, remote) for local, remote in zip(clocks[i], incoming)]
            if kind != "receive" or mode == "vector":
                clocks[i][i] += 1
            output["timestamp"] = clocks[i].copy()
        seen[identifier] = output
        result.append(output)
    return {"mode": mode, "processes": normalized, "events": result}
