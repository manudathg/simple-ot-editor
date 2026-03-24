function cloneOperation(operation) {
  return JSON.parse(JSON.stringify(operation));
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

  throw new Error(`Unknown operation type: ${operation.type}`);
}

function compareInsertionOrder(left, right) {
  if (left.pos !== right.pos) {
    return left.pos - right.pos;
  }

  return left.clientId.localeCompare(right.clientId) || left.id.localeCompare(right.id);
}

function transformInsertAgainstInsert(insertOp, againstOp) {
  const result = cloneOperation(insertOp);

  // If another insert lands before this one, this insert must move right.
  // When both inserts target the same position, we break ties deterministically
  // so every client converges on the same final ordering.
  if (
    againstOp.pos < result.pos ||
    (againstOp.pos === result.pos && compareInsertionOrder(againstOp, result) < 0)
  ) {
    result.pos += againstOp.text.length;
  }

  return result;
}

function transformInsertAgainstDelete(insertOp, againstOp) {
  const result = cloneOperation(insertOp);
  const deleteStart = againstOp.pos;
  const deleteEnd = againstOp.pos + againstOp.length;

  if (result.pos <= deleteStart) {
    return result;
  }

  if (result.pos >= deleteEnd) {
    result.pos -= againstOp.length;
    return result;
  }

  // In this demo, an insert that lands inside text deleted concurrently is
  // treated as absorbed by that delete. This keeps the model convergent with a
  // simple operation shape, at the cost of dropping some edge-case intent.
  result.noop = true;
  return result;
}

function transformDeleteAgainstInsert(deleteOp, againstOp) {
  const result = cloneOperation(deleteOp);
  const insertLength = againstOp.text.length;

  if (againstOp.pos >= result.pos + result.length) {
    return result;
  }

  if (againstOp.pos <= result.pos) {
    result.pos += insertLength;
    return result;
  }

  // The insert happened inside the range this delete intends to remove.
  // To keep deleting the same original characters, the delete range expands.
  result.length += insertLength;
  return result;
}

function transformDeleteAgainstDelete(deleteOp, againstOp) {
  const result = cloneOperation(deleteOp);
  const aStart = result.pos;
  const aEnd = result.pos + result.length;
  const bStart = againstOp.pos;
  const bEnd = againstOp.pos + againstOp.length;

  if (aEnd <= bStart) {
    return result;
  }

  if (aStart >= bEnd) {
    result.pos -= againstOp.length;
    return result;
  }

  // Overlapping deletes should not remove the same characters twice.
  // We compute the remaining range that still corresponds to this op's
  // original intent after the other delete has already been applied.
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  const overlapLength = overlapEnd - overlapStart;

  if (bStart < aStart) {
    result.pos = bStart;
  }

  result.length -= overlapLength;

  if (bStart < aStart) {
    result.pos -= Math.min(againstOp.length, aStart - bStart);
  }

  if (result.length < 0) {
    result.length = 0;
  }

  return result;
}

function transformOperation(operation, againstOperation) {
  if (operation.type === "insert" && againstOperation.type === "insert") {
    return transformInsertAgainstInsert(operation, againstOperation);
  }

  if (operation.type === "insert" && againstOperation.type === "delete") {
    return transformInsertAgainstDelete(operation, againstOperation);
  }

  if (operation.type === "delete" && againstOperation.type === "insert") {
    return transformDeleteAgainstInsert(operation, againstOperation);
  }

  if (operation.type === "delete" && againstOperation.type === "delete") {
    return transformDeleteAgainstDelete(operation, againstOperation);
  }

  throw new Error("Unsupported transform combination");
}

function rebaseOperation(operation, operations) {
  return operations.reduce((current, againstOp) => {
    if (current.noop) {
      return current;
    }

    const transformed = transformOperation(current, againstOp);
    return transformed.length === 0 && transformed.type === "delete"
      ? { ...transformed, noop: true }
      : transformed;
  }, cloneOperation(operation));
}

module.exports = {
  applyOperation,
  rebaseOperation,
  transformOperation
};
