const { applyOperation, rebaseOperation } = require("./ot");

class DocumentStore {
  constructor() {
    this.initialText =
      "<h1>Simple OT Editor</h1><p>This is a small Operational Transform demo with a lightweight rich text toolbar.</p><p>Open this page in two tabs, format some text, and type at the same time.</p>";
    this.document = this.createInitialDocument();
  }

  createInitialDocument() {
    return {
      id: "demo-doc",
      name: "Shared Demo Document",
      text: this.initialText,
      revision: 0,
      history: []
    };
  }

  getSnapshot() {
    return {
      id: this.document.id,
      name: this.document.name,
      text: this.document.text,
      revision: this.document.revision
    };
  }

  getOperationsSince(revision) {
    return this.document.history.slice(revision);
  }

  submitOperation(rawOperation) {
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

    const concurrentOperations = this.getOperationsSince(operation.baseRevision);
    const transformed = rebaseOperation(operation, concurrentOperations);

    if (!transformed.noop) {
      this.document.text = applyOperation(this.document.text, transformed);
    }

    const committed = {
      ...transformed,
      baseRevision: this.document.revision,
      revision: this.document.revision + 1
    };

    this.document.history.push(committed);
    this.document.revision += 1;

    return {
      snapshot: this.getSnapshot(),
      committed
    };
  }

  reset() {
    this.document = this.createInitialDocument();
    return this.getSnapshot();
  }
}

module.exports = {
  DocumentStore
};
