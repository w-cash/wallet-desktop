export {};

const { createWcashDeviceOwnerVerifier, linuxProcessSubject } = require("../../public/wcashDeviceAuth");

const immediateTimeout = async (probe: () => unknown, fallback: unknown) => {
  try {
    return await probe();
  } catch {
    return fallback;
  }
};

const base = {
  reason: "Authorize Wcash Testnet transaction",
  getWindow: () => null,
  execFile: jest.fn(),
  readFileSync: jest.fn(),
  userId: 501,
  withTimeout: immediateTimeout,
  appId: "com.wcashwallet.warden.testnet",
  processId: 123,
  probeTimeoutMs: 3_000,
  verifyTimeoutMs: 60_000,
};

describe("Wcash device-owner authentication", () => {
  it("accepts only an exact own success record from macOS", async () => {
    const values = [
      true,
      1,
      "true",
      { success: true, extra: "untrusted" },
      Object.create({ success: true }),
      { success: false },
    ];

    for (const value of values) {
      const verifier = createWcashDeviceOwnerVerifier();
      await expect(
        verifier.verify({
          ...base,
          platform: "darwin",
          native: { checkMacAuth: async () => "available", verifyMacUser: async () => value },
        }),
      ).resolves.toEqual({ success: false, reason: "device-auth-rejected" });
    }

    const verifier = createWcashDeviceOwnerVerifier();
    await expect(
      verifier.verify({
        ...base,
        platform: "darwin",
        native: { checkMacAuth: async () => "available", verifyMacUser: async () => ({ success: true }) },
      }),
    ).resolves.toEqual({ success: true });
  });

  it.each(["not_supported", "not_configured", "available\n", undefined, null, true])(
    "fails closed without an exact availability result: %p",
    async (availability) => {
      const verifyMacUser = jest.fn();
      const verifier = createWcashDeviceOwnerVerifier();
      await expect(
        verifier.verify({
          ...base,
          platform: "darwin",
          native: { checkMacAuth: async () => availability, verifyMacUser },
        }),
      ).resolves.toEqual({ success: false, reason: "device-auth-unavailable" });
      expect(verifyMacUser).not.toHaveBeenCalled();
    },
  );

  it("keeps a timed-out native challenge single-flight until it really settles", async () => {
    let release!: (value: unknown) => void;
    const challenge = new Promise((resolve) => {
      release = resolve;
    });
    let timeoutCall = 0;
    const withTimeout = async (probe: () => unknown, fallback: unknown) => {
      timeoutCall += 1;
      if (timeoutCall === 2) {
        void probe();
        return fallback;
      }
      return probe();
    };
    const native = { checkMacAuth: async () => "available", verifyMacUser: jest.fn(() => challenge) };
    const verifier = createWcashDeviceOwnerVerifier();

    await expect(verifier.verify({ ...base, platform: "darwin", native, withTimeout })).resolves.toEqual({
      success: false,
      reason: "device-auth-timeout",
    });
    await expect(verifier.verify({ ...base, platform: "darwin", native })).resolves.toEqual({
      success: false,
      reason: "device-auth-busy",
    });
    expect(native.verifyMacUser).toHaveBeenCalledTimes(1);

    release({ success: false });
    await challenge;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it("owns Windows Hello with the trusted window handle and rejects extra native fields", async () => {
    const handle = Buffer.from([0x34, 0x12, 0, 0, 0, 0, 0, 0]);
    const window = {
      isDestroyed: jest.fn(() => false),
      getNativeWindowHandle: jest.fn(() => handle),
      isMinimized: jest.fn(() => true),
      restore: jest.fn(),
      isVisible: jest.fn(() => false),
      show: jest.fn(),
      focus: jest.fn(),
      blur: jest.fn(),
    };
    const verifyWindowsUser = jest.fn(async (_handle: Buffer, _reason: string) => ({
      success: true,
      diagnostic: "untrusted",
    }));
    const verifier = createWcashDeviceOwnerVerifier();
    await expect(
      verifier.verify({
        ...base,
        platform: "win32",
        getWindow: () => window,
        native: {
          checkWindowsHello: async () => "available",
          verifyWindowsUser,
        },
      }),
    ).resolves.toEqual({ success: false, reason: "device-auth-rejected" });
    expect(verifyWindowsUser).toHaveBeenCalledTimes(1);
    expect(verifyWindowsUser).toHaveBeenCalledWith(expect.any(Buffer), "Authorize Wcash Testnet transaction");
    expect(verifyWindowsUser.mock.calls[0][0]).toEqual(handle);
    expect(verifyWindowsUser.mock.calls[0][0]).not.toBe(handle);
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(2);
    expect(window.blur).not.toHaveBeenCalled();
  });

  it("accepts Windows verification only while the same owner and handle remain current", async () => {
    const handle = Buffer.from([0x34, 0x12, 0, 0, 0, 0, 0, 0]);
    const window = {
      isDestroyed: () => false,
      getNativeWindowHandle: () => Buffer.from(handle),
      focus: jest.fn(),
    };
    const getWindow = jest.fn(() => window);
    const verifier = createWcashDeviceOwnerVerifier();

    await expect(
      verifier.verify({
        ...base,
        platform: "win32",
        getWindow,
        native: {
          checkWindowsHello: async () => "available",
          verifyWindowsUser: async () => ({ success: true }),
        },
      }),
    ).resolves.toEqual({ success: true });
    expect(getWindow).toHaveBeenCalledTimes(2);
  });

  it("rejects Windows verification if the trusted owner changes while the prompt is active", async () => {
    const first = {
      isDestroyed: () => false,
      getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
    };
    const replacement = {
      isDestroyed: () => false,
      getNativeWindowHandle: () => Buffer.from([2, 0, 0, 0, 0, 0, 0, 0]),
    };
    let current = first;
    const verifier = createWcashDeviceOwnerVerifier();

    await expect(
      verifier.verify({
        ...base,
        platform: "win32",
        getWindow: () => current,
        native: {
          checkWindowsHello: async () => "available",
          verifyWindowsUser: async () => {
            current = replacement;
            return { success: true };
          },
        },
      }),
    ).resolves.toEqual({ success: false, reason: "device-auth-rejected" });
  });

  it.each([
    ["missing owner", () => null],
    ["destroyed owner", () => ({ isDestroyed: () => true, getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]) })],
    ["zero owner handle", () => ({ isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8) })],
    [
      "wrong-sized owner handle",
      () => ({ isDestroyed: () => false, getNativeWindowHandle: () => Buffer.from([1, 2, 3]) }),
    ],
  ])("fails closed for a %s", async (_caseName, getWindow) => {
    const verifyWindowsUser = jest.fn();
    const verifier = createWcashDeviceOwnerVerifier();
    await expect(
      verifier.verify({
        ...base,
        platform: "win32",
        getWindow,
        native: { checkWindowsHello: async () => "available", verifyWindowsUser },
      }),
    ).resolves.toMatchObject({ success: false });
    expect(verifyWindowsUser).not.toHaveBeenCalled();
  });

  it("does not reuse a Windows handle after its trusted owner closes during the probe", async () => {
    let destroyed = false;
    const verifyWindowsUser = jest.fn();
    const verifier = createWcashDeviceOwnerVerifier();
    await expect(
      verifier.verify({
        ...base,
        platform: "win32",
        getWindow: () => ({
          isDestroyed: () => destroyed,
          getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
        }),
        native: {
          checkWindowsHello: async () => {
            destroyed = true;
            return "available";
          },
          verifyWindowsUser,
        },
      }),
    ).resolves.toEqual({ success: false, reason: "device-auth-unavailable" });
    expect(verifyWindowsUser).not.toHaveBeenCalled();
  });

  it("binds Linux polkit to the exact PID, start time, and UID using absolute binaries", async () => {
    const fields = Array.from({ length: 20 }, () => "1");
    fields[0] = "S";
    fields[19] = "987654";
    const readFileSync = jest.fn(() => `123 (Wcash Warden worker) ${fields.join(" ")}\n`);
    const calls: Array<{ command: string; args: string[]; timeout: number }> = [];
    const actionId = "com.wcashwallet.warden.testnet.authenticate";
    const execFile = jest.fn(
      (
        command: string,
        args: string[],
        options: { timeout: number },
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        calls.push({ command, args, timeout: options.timeout });
        callback(null, command.endsWith("pkaction") ? `${actionId}\n` : "");
      },
    );
    const verifier = createWcashDeviceOwnerVerifier();

    await expect(verifier.verify({ ...base, platform: "linux", native: {}, execFile, readFileSync })).resolves.toEqual({
      success: true,
    });
    expect(calls).toEqual([
      {
        command: "/usr/bin/pkaction",
        args: ["--action-id", actionId],
        timeout: 3_000,
      },
      {
        command: "/usr/bin/pkcheck",
        args: ["--action-id", actionId, "--process", "123,987654,501", "--allow-user-interaction"],
        timeout: 60_000,
      },
    ]);
  });

  it("does not accept a substring match from pkaction", async () => {
    const fields = Array.from({ length: 20 }, () => "1");
    fields[0] = "S";
    fields[19] = "99";
    const execFile = jest.fn(
      (_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) =>
        callback(null, "prefix.com.wcashwallet.warden.testnet.authenticate.suffix\n"),
    );
    const verifier = createWcashDeviceOwnerVerifier();
    await expect(
      verifier.verify({
        ...base,
        platform: "linux",
        native: {},
        execFile,
        readFileSync: () => `123 (warden) ${fields.join(" ")}\n`,
      }),
    ).resolves.toEqual({ success: false, reason: "device-auth-unavailable" });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("parses Linux process names containing spaces and parentheses without a PID race", () => {
    const fields = Array.from({ length: 20 }, () => "1");
    fields[0] = "S";
    fields[19] = "4567";
    expect(linuxProcessSubject(321, 1000, () => `321 (worker (safe) name) ${fields.join(" ")}\n`)).toBe(
      "321,4567,1000",
    );
    expect(() => linuxProcessSubject(322, 1000, () => `321 (worker) ${fields.join(" ")}\n`)).toThrow(
      "process ID changed",
    );
  });

  it("fails closed on unsupported platforms and invalid timeout configuration", async () => {
    const verifier = createWcashDeviceOwnerVerifier();
    await expect(verifier.verify({ ...base, platform: "freebsd", native: {} })).resolves.toEqual({
      success: false,
      reason: "device-auth-unsupported",
    });
    await expect(verifier.verify({ ...base, platform: "darwin", native: {}, verifyTimeoutMs: 0 })).rejects.toThrow(
      "timeouts are invalid",
    );
  });
});
