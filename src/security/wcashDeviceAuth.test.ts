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

  it("restores the trusted Windows window and rejects extra native fields", async () => {
    const window = { blur: jest.fn(), focus: jest.fn() };
    const verifier = createWcashDeviceOwnerVerifier();
    await expect(
      verifier.verify({
        ...base,
        platform: "win32",
        getWindow: () => window,
        native: {
          checkWindowsHello: async () => "available",
          verifyWindowsUser: async () => ({ success: true, diagnostic: "untrusted" }),
        },
      }),
    ).resolves.toEqual({ success: false, reason: "device-auth-rejected" });
    expect(window.blur).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
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
