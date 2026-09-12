import { parseZcashURI } from "./uris";

// Wcash does not expose the inherited Zcash address parser to the renderer.
// These tests keep the dormant legacy helper fail-closed until it is removed
// with the rest of the unreachable Zcash UI.
jest.mock("../electronBridge", () => ({
  native: {
    parse_address: jest.fn().mockRejectedValue(new Error("legacy runtime disabled")),
  },
  clipboard: { writeText: jest.fn() },
  shell: { openExternal: jest.fn() },
  ipcRenderer: { on: jest.fn(), off: jest.fn(), invoke: jest.fn() },
  fs: { promises: { readFile: jest.fn() }, existsSync: jest.fn() },
  isSandboxed: false,
}));

describe("disabled legacy payment URI boundary", () => {
  let consoleError;

  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test.each([
    "zcash:tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU",
    "zcash:ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez?amount=1",
    "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU",
  ])("rejects inherited Zcash recipient %s", async (uri) => {
    await expect(parseZcashURI(uri, "test")).resolves.toMatch(/^Error:/);
  });

  test.each(["", "badprotocol:anything", "wcash:wutest1not-a-canonical-address"])(
    "rejects unregistered payment URI %s",
    async (uri) => {
      await expect(parseZcashURI(uri, "test")).resolves.toMatch(/^Error:/);
    },
  );
});
