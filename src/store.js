const fs = require("node:fs");
const path = require("node:path");

const { applyOperation, rebaseOperation } = require("./ot");

class TenantDocumentStore {
  constructor(options = {}) {
    this.maxEditors = options.maxEditors || 3;
    this.dataFile =
      options.dataFile || path.join(__dirname, "..", "data", "tenants.json");
    this.initialText =
      "<h1>Simple OT Editor</h1><p>This is a small Operational Transform demo with a lightweight rich text toolbar.</p><p>Open this page in two tabs, format some text, and type at the same time.</p>";
    this.tenants = new Map();
    this.ensureDataDirectory();
    this.load();
  }

  ensureDataDirectory() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
  }

  createInitialDocument(tenantId) {
    return {
      id: `${tenantId}-doc`,
      tenantId,
      name: `${tenantId} Shared Document`,
      text: this.initialText,
      revision: 0,
      history: []
    };
  }

  hydrateTenant(tenantId) {
    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, this.createInitialDocument(tenantId));
    }

    return this.tenants.get(tenantId);
  }

  load() {
    if (!fs.existsSync(this.dataFile)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.dataFile, "utf8");
      const parsed = JSON.parse(raw);

      for (const [tenantId, document] of Object.entries(parsed)) {
        this.tenants.set(tenantId, {
          ...this.createInitialDocument(tenantId),
          ...document
        });
      }
    } catch {
      // Ignore a broken local persistence file and rebuild from defaults.
    }
  }

  save() {
    const serialized = Object.fromEntries(this.tenants.entries());
    fs.writeFileSync(this.dataFile, JSON.stringify(serialized, null, 2));
  }

  getSnapshot(tenantId) {
    const document = this.hydrateTenant(tenantId);
    return {
      id: document.id,
      tenantId: document.tenantId,
      name: document.name,
      text: document.text,
      revision: document.revision
    };
  }

  getOperationsSince(tenantId, revision) {
    const document = this.hydrateTenant(tenantId);
    return document.history.slice(revision);
  }

  submitOperation(tenantId, rawOperation) {
    const document = this.hydrateTenant(tenantId);
    const operation = {
      id: rawOperation.id,
      clientId: rawOperation.clientId,
      baseRevision: rawOperation.baseRevision,
      type: rawOperation.type,
      pos: rawOperation.pos
    };

    if (operation.type === "insert") {
      operation.text = rawOperation.text;
    } else if (operation.type === "delete") {
      operation.length = rawOperation.length;
    } else {
      throw new Error("Invalid operation type");
    }

    const concurrentOperations = this.getOperationsSince(tenantId, operation.baseRevision);
    const transformed = rebaseOperation(operation, concurrentOperations);

    if (!transformed.noop) {
      document.text = applyOperation(document.text, transformed);
    }

    const committed = {
      ...transformed,
      tenantId,
      baseRevision: document.revision,
      revision: document.revision + 1
    };

    document.history.push(committed);
    document.revision += 1;
    this.save();

    return {
      snapshot: this.getSnapshot(tenantId),
      committed
    };
  }

  reset(tenantId) {
    this.tenants.set(tenantId, this.createInitialDocument(tenantId));
    this.save();
    return this.getSnapshot(tenantId);
  }
}

module.exports = {
  TenantDocumentStore
};
