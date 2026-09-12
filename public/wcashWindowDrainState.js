"use strict";

function createWcashWindowDrainState() {
  let draining = false;
  let reopenRequested = false;

  function beginDrain() {
    draining = true;
  }

  function requestReopenOnActivation() {
    if (!draining) return false;
    reopenRequested = true;
    return true;
  }

  function finishClose() {
    const shouldReopen = draining && reopenRequested;
    draining = false;
    reopenRequested = false;
    return shouldReopen;
  }

  return Object.freeze({ beginDrain, finishClose, requestReopenOnActivation });
}

module.exports = { createWcashWindowDrainState };
