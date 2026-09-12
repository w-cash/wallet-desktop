export {};

const { createWcashIpcBoundary } = require("../../public/wcashIpcBoundary");

function harness(trustedUrl = "file:///Applications/Wcash%20Warden/resources/app/build/index.html") {
  const trustedFrame = { url: `${trustedUrl}#/wallet` };
  const trustedWebContents = { mainFrame: trustedFrame };
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipcMain = {
    handle: jest.fn((channel, handler) => handlers.set(channel, handler)),
  };
  const boundary = createWcashIpcBoundary({
    trustedUrl,
    getTrustedWebContents: () => trustedWebContents,
  });
  const trustedEvent = { sender: trustedWebContents, senderFrame: trustedFrame };
  return { boundary, handlers, ipcMain, trustedEvent, trustedFrame, trustedUrl, trustedWebContents };
}

describe("Wcash privileged IPC boundary", () => {
  it("accepts only the exact top-level renderer URL while allowing hash routes", () => {
    const { boundary, trustedEvent, trustedFrame, trustedUrl, trustedWebContents } = harness();

    expect(() => boundary.assertTrustedEvent(trustedEvent)).not.toThrow();
    const lookalikeFrame = { url: `${trustedUrl}.attacker` };
    trustedWebContents.mainFrame = lookalikeFrame;
    expect(() => boundary.assertTrustedEvent({ sender: trustedWebContents, senderFrame: lookalikeFrame })).toThrow(
      "untrusted renderer",
    );
    const otherFileFrame = { url: "file:///tmp/index.html" };
    trustedWebContents.mainFrame = otherFileFrame;
    expect(() => boundary.assertTrustedEvent({ sender: trustedWebContents, senderFrame: otherFileFrame })).toThrow(
      "untrusted renderer",
    );
    trustedWebContents.mainFrame = trustedFrame;
    expect(() =>
      boundary.assertTrustedEvent({
        sender: { mainFrame: trustedFrame },
        senderFrame: trustedFrame,
      }),
    ).toThrow("untrusted renderer");
    expect(() =>
      boundary.assertTrustedEvent({
        sender: trustedWebContents,
        senderFrame: { url: `${trustedUrl}#/wallet` },
      }),
    ).toThrow("untrusted renderer");
  });

  it("rejects an untrusted sender before invoking an operation", async () => {
    const { boundary, handlers, ipcMain, trustedEvent } = harness();
    const operation = jest.fn();
    boundary.register(ipcMain, "wcash:test", operation);
    const handler = handlers.get("wcash:test")!;

    expect(() => handler({ ...trustedEvent, senderFrame: { url: "https://attacker.invalid/" } })).toThrow(
      "untrusted renderer",
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("serializes every normal operation even after rejection", async () => {
    const { boundary, handlers, ipcMain, trustedEvent } = harness();
    const releases: Array<() => void> = [];
    const events: string[] = [];
    boundary.register(ipcMain, "wcash:serialized", async (label: string) => {
      events.push(`start:${label}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      events.push(`end:${label}`);
      if (label === "first") throw new Error("first failed");
      return label;
    });
    const handler = handlers.get("wcash:serialized")!;

    const first = handler(trustedEvent, "first");
    const second = handler(trustedEvent, "second");
    await Promise.resolve();
    expect(events).toEqual(["start:first"]);
    releases.shift()!();
    await expect(first).rejects.toThrow("first failed");
    await Promise.resolve();
    expect(events).toEqual(["start:first", "end:first", "start:second"]);
    releases.shift()!();
    await expect(second).resolves.toBe("second");
  });

  it("keeps stop-sync out of band while still validating its sender", async () => {
    const { boundary, handlers, ipcMain, trustedEvent } = harness();
    let release!: () => void;
    boundary.register(
      ipcMain,
      "wcash:slow",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = jest.fn(() => true);
    boundary.register(ipcMain, "wcash:stop", stop, { outOfBand: true });

    const slow = handlers.get("wcash:slow")!(trustedEvent);
    await Promise.resolve();
    expect(handlers.get("wcash:stop")!(trustedEvent)).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    release();
    await slow;
  });

  it("closes the gate before draining accepted serialized operations", async () => {
    const { boundary, handlers, ipcMain, trustedEvent } = harness();
    let release!: () => void;
    const events: string[] = [];
    boundary.register(ipcMain, "wcash:slow", async () => {
      events.push("start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      events.push("end");
      return "complete";
    });
    const rejected = jest.fn();
    boundary.register(ipcMain, "wcash:rejected-during-shutdown", rejected);

    const slow = handlers.get("wcash:slow")!(trustedEvent);
    await Promise.resolve();
    const drained = boundary.drain();
    let drainFinished = false;
    void drained.then(() => {
      drainFinished = true;
    });

    expect(() => handlers.get("wcash:rejected-during-shutdown")!(trustedEvent)).toThrow(
      "rejected an operation during shutdown",
    );
    expect(rejected).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(drainFinished).toBe(false);
    expect(events).toEqual(["start"]);

    release();
    await expect(slow).resolves.toBe("complete");
    await expect(drained).resolves.toBeUndefined();
    expect(drainFinished).toBe(true);
    expect(events).toEqual(["start", "end"]);
  });

  it("drains rejected work and resumes only after every accepted operation settles", async () => {
    const { boundary, handlers, ipcMain, trustedEvent } = harness();
    let rejectOperation!: (error: Error) => void;
    const operation = jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOperation = reject;
        }),
    );
    boundary.register(ipcMain, "wcash:operation", operation);
    const handler = handlers.get("wcash:operation")!;

    const failed = handler(trustedEvent);
    await Promise.resolve();
    boundary.beginShutdown();
    expect(() => boundary.resume()).toThrow("cannot resume before shutdown operations drain");

    const drained = boundary.drain();
    rejectOperation(new Error("native operation failed"));
    await expect(failed).rejects.toThrow("native operation failed");
    await expect(drained).resolves.toBeUndefined();

    expect(() => boundary.resume()).not.toThrow();
    operation.mockResolvedValueOnce(undefined);
    await expect(handler(trustedEvent)).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("rejects out-of-band operations after shutdown begins", () => {
    const { boundary, handlers, ipcMain, trustedEvent } = harness();
    const stop = jest.fn(() => true);
    boundary.register(ipcMain, "wcash:stop", stop, { outOfBand: true });

    boundary.beginShutdown();

    expect(() => handlers.get("wcash:stop")!(trustedEvent)).toThrow("rejected an operation during shutdown");
    expect(stop).not.toHaveBeenCalled();
  });

  it("cancels a queued sync at shutdown without abandoning queued durable work", async () => {
    const { boundary, handlers, ipcMain, trustedEvent } = harness();
    let release!: () => void;
    boundary.register(
      ipcMain,
      "wcash:blocking",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const durable = jest.fn(() => "durable-complete");
    const sync = jest.fn(() => "sync-started");
    boundary.register(ipcMain, "wcash:durable", durable);
    boundary.register(ipcMain, "wcash:sync", sync, { cancelOnShutdown: true });

    const blocking = handlers.get("wcash:blocking")!(trustedEvent);
    const durableResult = handlers.get("wcash:durable")!(trustedEvent);
    const syncResult = handlers.get("wcash:sync")!(trustedEvent);
    await Promise.resolve();
    const drained = boundary.drain();
    release();

    await expect(blocking).resolves.toBeUndefined();
    await expect(durableResult).resolves.toBe("durable-complete");
    await expect(syncResult).rejects.toThrow("rejected an operation during shutdown");
    await expect(drained).resolves.toBeUndefined();
    expect(durable).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
  });
});
