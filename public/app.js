const editor = document.getElementById("editor");
const toolbar = document.getElementById("toolbar");
const styleSelect = document.getElementById("style-select");
const colorPicker = document.getElementById("color-picker");
const clearFormatButton = document.getElementById("clear-format");
const presenceEl = document.getElementById("presence");
const eventLogEl = document.getElementById("event-log");
const documentNameEl = document.getElementById("document-name");
const revisionEl = document.getElementById("revision");
const knownRevisionEl = document.getElementById("known-revision");
const clientNameEl = document.getElementById("client-name");
const clientIdEl = document.getElementById("client-id");
const pendingCountEl = document.getElementById("pending-count");
const syncToggleEl = document.getElementById("sync-toggle");
const resetButtonEl = document.getElementById("reset-button");

let socket;
let client = null;
let serverText = "";
let currentText = "";
let revision = 0;
let pending = null;
let buffer = [];
let previousValue = "";
let suppressInput = false;
let localSequence = 0;
let isManuallyDisconnected = false;
let reconnectingWithDraft = false;

function isConnected() {
  return socket && socket.readyState === WebSocket.OPEN;
}

function getStoredClient() {
  try {
    return JSON.parse(window.sessionStorage.getItem("simple-ot-editor-client") || "null");
  } catch {
    return null;
  }
}

function storeClientIdentity(nextClient) {
  window.sessionStorage.setItem("simple-ot-editor-client", JSON.stringify(nextClient));
}

function logEvent(message) {
  const entry = document.createElement("div");
  entry.className = "event";
  entry.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
  eventLogEl.prepend(entry);

  while (eventLogEl.childElementCount > 8) {
    eventLogEl.removeChild(eventLogEl.lastChild);
  }
}

function setSyncStatus(kind, label) {
  syncToggleEl.textContent = label;
  syncToggleEl.className = `status-pill status-${kind}`;
}

function renderPresence(users) {
  presenceEl.innerHTML = "";

  users.forEach((user) => {
    const chip = document.createElement("div");
    chip.className = "presence-user";
    chip.innerHTML = `<span class="presence-dot" style="background:${user.color}"></span>${user.name}`;
    presenceEl.appendChild(chip);
  });
}

function updateRevision(nextRevision) {
  revision = nextRevision;
  revisionEl.textContent = String(nextRevision);
  knownRevisionEl.textContent = String(nextRevision);
}

function updatePendingCount() {
  pendingCountEl.textContent = String((pending ? 1 : 0) + buffer.length);
}

function normalizeHtml(value) {
  const trimmed = value.trim();
  return trimmed === "" ? "<p><br></p>" : trimmed;
}

function getEditorValue() {
  return normalizeHtml(editor.innerHTML);
}

function replaceEditorValue(nextValue) {
  suppressInput = true;
  const normalized = normalizeHtml(nextValue);
  editor.innerHTML = normalized;
  previousValue = normalized;
  currentText = normalized;
  suppressInput = false;
}

function recomputeLocalText() {
  let nextText = serverText;

  if (pending) {
    nextText = applyOperation(nextText, pending);
  }

  for (const operation of buffer) {
    nextText = applyOperation(nextText, operation);
  }

  replaceEditorValue(nextText);
}

function applyOperation(text, operation) {
  if (operation.noop) {
    return text;
  }

  if (operation.type === "insert") {
    return text.slice(0, operation.pos) + operation.text + text.slice(operation.pos);
  }

  if (operation.type === "delete") {
    return text.slice(0, operation.pos) + text.slice(operation.pos + operation.length);
  }

  return text;
}

function compareInsertionOrder(left, right) {
  if (left.pos !== right.pos) {
    return left.pos - right.pos;
  }

  return left.clientId.localeCompare(right.clientId) || left.id.localeCompare(right.id);
}

function transformOperation(operation, against) {
  const result = structuredClone(operation);

  if (result.type === "insert" && against.type === "insert") {
    if (against.pos < result.pos || (against.pos === result.pos && compareInsertionOrder(against, result) < 0)) {
      result.pos += against.text.length;
    }
    return result;
  }

  if (result.type === "insert" && against.type === "delete") {
    const deleteEnd = against.pos + against.length;
    if (result.pos > against.pos && result.pos < deleteEnd) {
      result.noop = true;
    } else if (result.pos >= deleteEnd) {
      result.pos -= against.length;
    }
    return result;
  }

  if (result.type === "delete" && against.type === "insert") {
    if (against.pos <= result.pos) {
      result.pos += against.text.length;
    } else if (against.pos < result.pos + result.length) {
      result.length += against.text.length;
    }
    return result;
  }

  if (result.type === "delete" && against.type === "delete") {
    const aStart = result.pos;
    const aEnd = result.pos + result.length;
    const bStart = against.pos;
    const bEnd = against.pos + against.length;

    if (aEnd <= bStart) {
      return result;
    }

    if (aStart >= bEnd) {
      result.pos -= against.length;
      return result;
    }

    const overlapStart = Math.max(aStart, bStart);
    const overlapEnd = Math.min(aEnd, bEnd);
    const overlapLength = overlapEnd - overlapStart;

    if (bStart < aStart) {
      result.pos = bStart - Math.min(against.length, aStart - bStart);
    }

    result.length -= overlapLength;
    if (result.length < 0) {
      result.length = 0;
    }

    return result;
  }

  return result;
}

function rebasePending(againstOperation) {
  if (pending) {
    pending = transformOperation(pending, againstOperation);
  }

  buffer = buffer.map((operation) => transformOperation(operation, againstOperation));
  updatePendingCount();
}

function flushBuffer() {
  if (!isConnected() || pending || buffer.length === 0) {
    return;
  }

  pending = buffer.shift();
  socket.send(JSON.stringify({ type: "operation", operation: pending }));
  setSyncStatus("syncing", "Syncing");
  updatePendingCount();
}

function queueOperation(operation) {
  if (!isConnected()) {
    buffer.push(operation);
    updatePendingCount();
    return;
  }

  if (!pending) {
    pending = operation;
    socket.send(JSON.stringify({ type: "operation", operation }));
    setSyncStatus("syncing", "Syncing");
  } else {
    buffer.push(operation);
  }

  updatePendingCount();
}

function makeOperationFromChange(oldValue, newValue) {
  if (!client) {
    return [];
  }

  let start = 0;
  while (start < oldValue.length && start < newValue.length && oldValue[start] === newValue[start]) {
    start += 1;
  }

  let oldEnd = oldValue.length - 1;
  let newEnd = newValue.length - 1;
  while (oldEnd >= start && newEnd >= start && oldValue[oldEnd] === newValue[newEnd]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const removed = oldValue.slice(start, oldEnd + 1);
  const inserted = newValue.slice(start, newEnd + 1);
  const operations = [];

  if (removed.length > 0) {
    operations.push({
      id: `${client.clientId}:${localSequence++}`,
      clientId: client.clientId,
      baseRevision: revision,
      type: "delete",
      pos: start,
      length: removed.length
    });
  }

  if (inserted.length > 0) {
    operations.push({
      id: `${client.clientId}:${localSequence++}`,
      clientId: client.clientId,
      baseRevision: revision,
      type: "insert",
      pos: start,
      text: inserted
    });
  }

  return operations;
}

function queueDiffOperations(oldValue, newValue) {
  const operations = makeOperationFromChange(oldValue, newValue);
  operations.forEach((operation) => queueOperation(operation));
}

function resetLocalState(nextText = "", nextRevision = 0) {
  pending = null;
  buffer = [];
  serverText = normalizeHtml(nextText);
  currentText = serverText;
  previousValue = serverText;
  updateRevision(nextRevision);
  updatePendingCount();
  replaceEditorValue(serverText);
}

function disconnect(reason = "Disconnected") {
  isManuallyDisconnected = true;
  setSyncStatus("connecting", "Disconnected");
  if (socket) {
    const currentSocket = socket;
    socket = null;
    currentSocket.close();
  }
  logEvent(reason);
}

function applyToolbarCommand(command, value = null) {
  editor.focus();
  document.execCommand(command, false, value);
}

function connect() {
  isManuallyDisconnected = false;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const storedClient = client || getStoredClient();
  const params = new URLSearchParams();

  if (storedClient?.slot) {
    params.set("slot", String(storedClient.slot));
  }
  if (storedClient?.clientId) {
    params.set("clientId", storedClient.clientId);
  }
  if (storedClient?.name) {
    params.set("name", storedClient.name);
  }
  if (storedClient?.color) {
    params.set("color", storedClient.color);
  }

  socket = new WebSocket(`${protocol}://${window.location.host}?${params.toString()}`);
  setSyncStatus("connecting", "Connecting");

  socket.addEventListener("open", () => {
    setSyncStatus("connected", "Connected");
    logEvent("WebSocket connected.");
  });

  socket.addEventListener("close", () => {
    if (!isManuallyDisconnected) {
      setSyncStatus("connecting", "Disconnected");
      logEvent("Connection closed.");
    }
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "welcome") {
      const localDraft = currentText;
      client = message.client;
      storeClientIdentity(client);
      documentNameEl.textContent = message.document.name;
      clientNameEl.textContent = client.name;
      clientIdEl.textContent = client.clientId;
      serverText = normalizeHtml(message.document.text);
      updateRevision(message.document.revision);
      renderPresence(message.users);
      updatePendingCount();
      logEvent(`Joined ${message.document.name} as ${client.name}.`);

      if (reconnectingWithDraft && normalizeHtml(localDraft) !== serverText) {
        pending = null;
        buffer = [];
        replaceEditorValue(localDraft);
        previousValue = serverText;
        currentText = normalizeHtml(localDraft);
        queueDiffOperations(serverText, currentText);
        previousValue = currentText;
        reconnectingWithDraft = false;
        return;
      }

      reconnectingWithDraft = false;
      replaceEditorValue(serverText);
      return;
    }

    if (message.type === "presence") {
      renderPresence(message.users);
      logEvent(`Presence updated: ${message.users.length} connected.`);
      return;
    }

    if (message.type === "ack") {
      serverText = normalizeHtml(message.text);
      if (pending && pending.id === message.operationId) {
        pending = null;
      }

      updateRevision(message.revision);
      updatePendingCount();
      flushBuffer();
      recomputeLocalText();

      if (!pending) {
        setSyncStatus("connected", "Connected");
      }

      logEvent(`Operation acknowledged at revision ${message.revision}.`);
      return;
    }

    if (message.type === "remote-operation") {
      serverText = normalizeHtml(message.text);
      updateRevision(message.revision);
      rebasePending(message.operation);
      recomputeLocalText();
      logEvent(`Applied ${message.operation.type} from ${message.operation.clientId}.`);
      return;
    }

    if (message.type === "reset") {
      resetLocalState(message.document.text, message.document.revision);
      logEvent("Session reset.");
      return;
    }

    if (message.type === "error") {
      setSyncStatus("connecting", "Error");
      logEvent(`Server error: ${message.message}`);
    }
  });
}

editor.addEventListener("input", () => {
  if (suppressInput) {
    return;
  }

  const nextValue = getEditorValue();

  if (!isConnected()) {
    previousValue = nextValue;
    currentText = nextValue;
    updatePendingCount();
    return;
  }

  queueDiffOperations(previousValue, nextValue);
  previousValue = nextValue;
  currentText = nextValue;
});

toolbar.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

toolbar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-command]");
  if (!button) {
    return;
  }

  applyToolbarCommand(button.dataset.command);
});

styleSelect.addEventListener("change", () => {
  applyToolbarCommand("formatBlock", styleSelect.value);
});

colorPicker.addEventListener("input", () => {
  applyToolbarCommand("foreColor", colorPicker.value);
});

clearFormatButton.addEventListener("click", () => {
  applyToolbarCommand("removeFormat");
});

syncToggleEl.addEventListener("click", () => {
  if (isConnected()) {
    disconnect("Manual disconnect enabled. Local edits will stay in this tab until you reconnect.");
    return;
  }

  reconnectingWithDraft = currentText !== serverText;
  connect();
});

resetButtonEl.addEventListener("click", () => {
  if (!isConnected()) {
    logEvent("Reconnect before resetting the shared session.");
    return;
  }

  socket.send(JSON.stringify({ type: "reset" }));
});

connect();
