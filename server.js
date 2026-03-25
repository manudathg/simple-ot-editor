const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { URL } = require("node:url");

const { TenantDocumentStore } = require("./src/store");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const store = new TenantDocumentStore({
  dataFile: path.join(__dirname, "data", "tenants.json"),
  maxEditors: 3
});
const sockets = new Map();

function sendJson(socket, message) {
  socket.write(encodeWebSocketFrame(JSON.stringify(message)));
}

function getTenantClients(tenantId) {
  return Array.from(sockets.entries())
    .filter(([, client]) => client.tenantId === tenantId)
    .map(([socket, client]) => ({ socket, client }));
}

function getUsedSlots(tenantId) {
  return new Set(getTenantClients(tenantId).map(({ client }) => client.slot));
}

function allocateClientSlot(tenantId, preferredSlot) {
  const usedSlots = getUsedSlots(tenantId);

  if (preferredSlot && !usedSlots.has(preferredSlot)) {
    return preferredSlot;
  }

  let slot = 1;
  while (usedSlots.has(slot)) {
    slot += 1;
  }

  return slot;
}

function getEditorCount(tenantId) {
  return getTenantClients(tenantId).filter(({ client }) => client.role === "editor").length;
}

function broadcastToTenant(tenantId, message, excludeSocket) {
  for (const { socket } of getTenantClients(tenantId)) {
    if (socket !== excludeSocket) {
      sendJson(socket, message);
    }
  }
}

function broadcastPresence(tenantId) {
  const clients = getTenantClients(tenantId).map(({ client }) => ({
    clientId: client.clientId,
    name: client.name,
    color: client.color,
    role: client.role
  }));

  broadcastToTenant(tenantId, {
    type: "presence",
    users: clients,
    editorCount: clients.filter((client) => client.role === "editor").length,
    maxEditors: store.maxEditors
  });
}

function broadcastRole(clientEntry) {
  sendJson(clientEntry.socket, {
    type: "role",
    role: clientEntry.client.role,
    editorCount: getEditorCount(clientEntry.client.tenantId),
    maxEditors: store.maxEditors
  });
}

function maybePromoteViewer(tenantId) {
  const editorCount = getEditorCount(tenantId);
  if (editorCount >= store.maxEditors) {
    return;
  }

  const viewer = getTenantClients(tenantId).find(({ client }) => client.role === "viewer");
  if (!viewer) {
    return;
  }

  viewer.client.role = "editor";
  broadcastRole(viewer);
}

function randomColor() {
  const palette = ["#ff6b6b", "#1f7aec", "#00a37a", "#b86bff", "#ff9f1a", "#4d6274"];
  return palette[Math.floor(Math.random() * palette.length)];
}

function createClient(tenantId, preferred = {}) {
  const slot = allocateClientSlot(tenantId, preferred.slot);
  const canReuseIdentity = preferred.slot && preferred.slot === slot;
  const editorCount = getEditorCount(tenantId);
  const role = editorCount < store.maxEditors ? "editor" : "viewer";

  return {
    slot,
    tenantId,
    role,
    clientId: canReuseIdentity && preferred.clientId ? preferred.clientId : `client-${slot}`,
    name: canReuseIdentity && preferred.name ? preferred.name : `User ${slot}`,
    color: preferred.color || randomColor()
  };
}

function parseJsonMessage(message) {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function serveStaticFile(request, response) {
  let filePath = request.url === "/" ? "/index.html" : request.url;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const absolutePath = path.join(PUBLIC_DIR, filePath);

  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(absolutePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Internal server error");
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(absolutePath)] || "application/octet-stream"
    });
    response.end(request.method === "HEAD" ? "" : data);
  });
}

function encodeWebSocketFrame(payload) {
  const payloadBuffer = Buffer.from(payload);
  const payloadLength = payloadBuffer.length;
  let header;

  if (payloadLength < 126) {
    header = Buffer.from([0x81, payloadLength]);
  } else if (payloadLength < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
  }

  return Buffer.concat([header, payloadBuffer]);
}

function decodeWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = Boolean(secondByte & 0x80);
    let payloadLength = secondByte & 0x7f;
    let cursor = offset + 2;

    if (opcode === 0x8) {
      return { messages, remaining: Buffer.alloc(0), close: true };
    }

    if (!masked) {
      break;
    }

    if (payloadLength === 126) {
      if (cursor + 2 > buffer.length) {
        break;
      }
      payloadLength = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLength === 127) {
      if (cursor + 8 > buffer.length) {
        break;
      }
      payloadLength = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    if (cursor + 4 + payloadLength > buffer.length) {
      break;
    }

    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
    const payload = buffer.subarray(cursor, cursor + payloadLength);
    const unmasked = Buffer.alloc(payloadLength);

    for (let index = 0; index < payloadLength; index += 1) {
      unmasked[index] = payload[index] ^ mask[index % 4];
    }

    if (opcode === 0x1) {
      messages.push(unmasked.toString("utf8"));
    }

    offset = cursor + payloadLength;
  }

  return {
    messages,
    remaining: buffer.subarray(offset),
    close: false
  };
}

function handleClientMessage(socket, rawMessage) {
  const message = parseJsonMessage(rawMessage);
  if (!message) {
    return;
  }

  const client = sockets.get(socket);
  if (!client) {
    return;
  }

  if (message.type === "operation") {
    if (client.role !== "editor") {
      sendJson(socket, {
        type: "error",
        message: "This session is full. Viewers are read-only until an editor slot opens."
      });
      return;
    }

    try {
      const { snapshot, committed } = store.submitOperation(client.tenantId, {
        ...message.operation,
        clientId: client.clientId
      });

      sendJson(socket, {
        type: "ack",
        operationId: message.operation.id,
        revision: snapshot.revision,
        text: snapshot.text
      });

      broadcastToTenant(
        client.tenantId,
        {
          type: "remote-operation",
          operation: committed,
          revision: snapshot.revision,
          text: snapshot.text
        },
        socket
      );
    } catch (error) {
      sendJson(socket, {
        type: "error",
        message: error.message
      });
    }

    return;
  }

  if (message.type === "reset") {
    if (client.role !== "editor") {
      sendJson(socket, {
        type: "error",
        message: "Only active editors can reset a tenant session."
      });
      return;
    }

    const snapshot = store.reset(client.tenantId);
    broadcastToTenant(client.tenantId, {
      type: "reset",
      document: snapshot
    });
  }
}

const server = http.createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405);
    response.end("Method not allowed");
    return;
  }

  serveStaticFile(request, response);
});

server.on("upgrade", (request, socket) => {
  if (request.headers.upgrade !== "websocket") {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const tenantId =
    (requestUrl.searchParams.get("tenant") || "demo").trim().replace(/[^a-zA-Z0-9-_]/g, "") ||
    "demo";
  const preferredSlot = Number.parseInt(requestUrl.searchParams.get("slot") || "", 10);
  const preferredClientId = requestUrl.searchParams.get("clientId");
  const preferredName = requestUrl.searchParams.get("name");
  const preferredColor = requestUrl.searchParams.get("color");

  const acceptKey = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n"
    ].join("\r\n")
  );

  const client = createClient(tenantId, {
    slot: Number.isFinite(preferredSlot) ? preferredSlot : null,
    clientId: preferredClientId || null,
    name: preferredName || null,
    color: preferredColor || null
  });

  sockets.set(socket, client);

  sendJson(socket, {
    type: "welcome",
    client,
    document: store.getSnapshot(tenantId),
    users: getTenantClients(tenantId).map(({ client: tenantClient }) => ({
      clientId: tenantClient.clientId,
      name: tenantClient.name,
      color: tenantClient.color,
      role: tenantClient.role
    })),
    editorCount: getEditorCount(tenantId),
    maxEditors: store.maxEditors
  });

  broadcastPresence(tenantId);

  let buffered = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const decoded = decodeWebSocketFrames(buffered);
    buffered = decoded.remaining;

    for (const message of decoded.messages) {
      handleClientMessage(socket, message);
    }

    if (decoded.close) {
      socket.end();
    }
  });

  function cleanup() {
    const disconnectedClient = sockets.get(socket);
    if (!disconnectedClient) {
      return;
    }

    const tenant = disconnectedClient.tenantId;
    sockets.delete(socket);
    maybePromoteViewer(tenant);
    broadcastPresence(tenant);
  }

  socket.on("close", cleanup);
  socket.on("end", cleanup);
  socket.on("error", cleanup);
});

server.listen(PORT, () => {
  console.log(`Simple OT editor running at http://localhost:${PORT}`);
});
