"""Validation and timestamp computation, independent of the HTTP transport."""

MODES = {"lamport", "vector", "causal"}
MAX_PROCESSES = 16
MAX_EVENTS = 500


def _text(value, label, limit=80):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"{label} must be nonempty text of at most {limit} characters.")
    return value.strip()


def _merge(local, incoming):
    return [max(a, b) for a, b in zip(local, incoming)]


def _delivery_gaps(sender, vector, local):
    return [
        i for i, (count, delivered) in enumerate(zip(vector, local))
        if (count != delivered + 1 if i == sender else count > delivered)
    ]


def _receive_broadcast(clock, queue, sender, vector, broadcasts):
    failures = [
        {
            "source": i, "isSender": i == sender, "count": vector[i], "deliveredCount": clock[i],
            "blockers": broadcasts[i][clock[i]:vector[i] - (i == sender)],
        }
        for i in _delivery_gaps(sender, vector, clock)
    ]
    details = {"vector": vector, "delivered": clock.copy(), "failures": failures, "released": 0}
    queue.append((sender, vector))
    while True:
        ready = next(
            (i for i, (source, stamp) in enumerate(queue) if not _delivery_gaps(source, stamp, clock)),
            None,
        )
        if ready is None:
            break
        _, stamp = queue.pop(ready)
        clock[:] = _merge(clock, stamp)
        details["released"] += 1
    # Count previously buffered messages released by this arrival.
    if not failures:
        details["released"] -= 1
    return details


def calculate(payload: dict) -> dict:
    """Return event clock snapshots for an execution, without mutating input.

    Events are topologically ordered: each receive references a prior send.
    Broadcast sends may have one receive per other process.
    Vector components follow process order.
    """
    if not isinstance(payload, dict):
        raise ValueError("The execution must be a JSON object.")
    mode = payload.get("mode", "lamport")
    if not isinstance(mode, str) or mode not in MODES:
        raise ValueError("Choose lamport, vector, or causal clocks.")
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
    queues = [[] for _ in indices]
    broadcasts = [[] for _ in indices]
    seen, received, result = {}, {}, []
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
        if "broadcast" in event:
            if kind != "send" or not isinstance(event["broadcast"], bool):
                raise ValueError("Only send events may have a boolean broadcast flag.")
            output["broadcast"] = event["broadcast"]
        incoming = None
        if kind == "receive":
            send_id = _text(event.get("send"), "Referenced send ID")
            sender = seen.get(send_id)
            if sender is None or sender["kind"] != "send":
                raise ValueError("A receive must reference an earlier send event.")
            if sender["process"] == process:
                raise ValueError("Messages must connect distinct processes.")
            recipients = received.setdefault(send_id, set())
            if process in recipients:
                raise ValueError("A process can receive a broadcast only once.")
            if recipients and not sender.get("broadcast", False):
                raise ValueError("A send event can have only one receiver.")
            recipients.add(process)
            output["send"] = send_id
            incoming = sender["timestamp"]
        if mode == "lamport":
            clocks[i] = max(clocks[i], incoming or 0) + 1
            output["timestamp"] = clocks[i]
        elif mode == "vector":
            if incoming is not None:
                clocks[i] = _merge(clocks[i], incoming)
            clocks[i][i] += 1
            output["timestamp"] = clocks[i].copy()
        else:
            if output.get("broadcast"):
                clocks[i][i] += 1
                broadcasts[i].append(identifier)
            elif kind == "receive" and sender.get("broadcast"):
                output["delivery"] = _receive_broadcast(
                    clocks[i], queues[i], indices[sender["process"]], incoming, broadcasts
                )
            output["timestamp"] = clocks[i].copy()
        seen[identifier] = output
        result.append(output)
    return {"mode": mode, "processes": normalized, "events": result}
