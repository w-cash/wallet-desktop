export {};

const { createWcashWindowDrainState } = require("../../public/wcashWindowDrainState");

describe("Wcash macOS window drain state", () => {
  it("preserves activation received while a window close is draining", () => {
    const state = createWcashWindowDrainState();

    expect(state.requestReopenOnActivation()).toBe(false);
    state.beginDrain();
    expect(state.requestReopenOnActivation()).toBe(true);
    expect(state.finishClose()).toBe(true);
    expect(state.finishClose()).toBe(false);
  });

  it("does not create a replacement without an activation request", () => {
    const state = createWcashWindowDrainState();

    state.beginDrain();
    expect(state.finishClose()).toBe(false);
  });
});
