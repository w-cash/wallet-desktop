import { parseZcashURI } from "./uris";
import Utils from "./utils";

jest.mock("../electronBridge", () => ({
  native: {},
  clipboard: { writeText: jest.fn() },
  shell: { openExternal: jest.fn() },
  ipcRenderer: { on: jest.fn(), off: jest.fn(), invoke: jest.fn() },
  fs: { promises: { readFile: jest.fn() }, existsSync: jest.fn() },
  isSandboxed: false,
}));

const WCASH_REGTEST_ADDRESS = "w" + "u" + "regtest1" + "q".repeat(90);

beforeEach(() => {
  jest.spyOn(Utils, "getAddressKind").mockImplementation(async (address, chain) =>
    address === WCASH_REGTEST_ADDRESS && chain === "regtest" ? "unified" : undefined,
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("Wcash payment URI with amount, memo, and message", async () => {
  const target = await parseZcashURI(
    `wcash:${WCASH_REGTEST_ADDRESS}?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg&message=Thank%20you%20for%20your%20purchase`,
    "regtest",
  );

  expect(typeof target).toBe("object");
  expect(target.address).toBe(WCASH_REGTEST_ADDRESS);
  expect(target.message).toBe("Thank you for your purchase");
  expect(target.label).toBeUndefined();
  expect(target.amount).toBe(1);
  expect(target.memoString).toBe("This is a simple memo.");
});

test("Wcash indexed payment URI", async () => {
  const target = await parseZcashURI(
    `wcash:?address=${WCASH_REGTEST_ADDRESS}&amount=123.456&address.1=${WCASH_REGTEST_ADDRESS}&amount.1=0.789&memo.1=VGhpcyBpcyBhIHVuaWNvZGUgbWVtbyDinKjwn6aE8J-PhvCfjok`,
    "regtest",
  );

  // This version of the app only reads the first item of the URI.
  expect(typeof target).toBe("object");
  expect(target.address).toBe(WCASH_REGTEST_ADDRESS);
  expect(target.message).toBeUndefined();
  expect(target.label).toBeUndefined();
  expect(target.amount).toBe(123.456);
  expect(target.memoString).toBeUndefined();
  expect(target.memoBase64).toBeUndefined();
});

test("Wcash address-only URI", async () => {
  const target = await parseZcashURI(`wcash:${WCASH_REGTEST_ADDRESS}`, "regtest");

  expect(typeof target).toBe("object");
  expect(target.address).toBe(WCASH_REGTEST_ADDRESS);
  expect(target.message).toBeUndefined();
  expect(target.label).toBeUndefined();
  expect(target.amount).toBeUndefined();
  expect(target.memoString).toBeUndefined();
  expect(target.memoBase64).toBeUndefined();
});

test("plain Wcash address", async () => {
  const result = await parseZcashURI(WCASH_REGTEST_ADDRESS, "regtest");

  expect(result).toBe(WCASH_REGTEST_ADDRESS);
});

test("rejects non-Wcash or malformed payment URIs", async () => {
  let error = await parseZcashURI(`zcash:${WCASH_REGTEST_ADDRESS}?amount=123.456`, "regtest");
  expect(error).toBe("Error: Invalid URI or protocol");

  error = await parseZcashURI("wcash:badaddress?amount=123.456", "regtest");
  expect(typeof error).toBe("string");

  error = await parseZcashURI("wcash:?amount=123.456", "regtest");
  expect(typeof error).toBe("string");

  error = await parseZcashURI(`wcash:${WCASH_REGTEST_ADDRESS}?badparam=3`, "regtest");
  expect(typeof error).toBe("string");

  error = await parseZcashURI(
    `wcash:${WCASH_REGTEST_ADDRESS}?amount=2&address.1=${WCASH_REGTEST_ADDRESS}`,
    "regtest",
  );
  expect(typeof error).toBe("string");

  // url-parse keeps the last duplicate value, so the parse succeeds.
  error = await parseZcashURI(`wcash:${WCASH_REGTEST_ADDRESS}?amount=3&amount=4`, "regtest");
  expect(typeof error).toBe("object");

  error = await parseZcashURI(
    `wcash:${WCASH_REGTEST_ADDRESS}?amount=2&address.a=${WCASH_REGTEST_ADDRESS}&amount.a=3`,
    "regtest",
  );
  expect(typeof error).toBe("string");

  error = await parseZcashURI(
    `wcash:${WCASH_REGTEST_ADDRESS}?amount=0.1&address.2=${WCASH_REGTEST_ADDRESS}&amount.2=2`,
    "regtest",
  );
  expect(typeof error).toBe("string");
});
