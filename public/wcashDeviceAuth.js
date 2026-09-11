"use strict";

function failed(reason) {
  return Object.freeze({ success: false, reason });
}

function verifiedOnly(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    value.success === true
    ? Object.freeze({ success: true })
    : failed("device-auth-rejected");
}

function challengeDecision(value) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    value.success === false &&
    (value.reason === "device-auth-timeout" || value.reason === "device-auth-busy")
  ) {
    return Object.freeze({ success: false, reason: value.reason });
  }
  return verifiedOnly(value);
}

function linuxProcessSubject(processId, userId, readFileSync) {
  if (!Number.isSafeInteger(processId) || processId < 1 || !Number.isSafeInteger(userId) || userId < 0) {
    throw new TypeError("Linux process identity is invalid");
  }
  const stat = readFileSync("/proc/self/stat", "utf8");
  if (typeof stat !== "string" || stat.length > 16 * 1024) {
    throw new TypeError("Linux process identity is unavailable");
  }
  if (!stat.startsWith(`${processId} (`)) throw new TypeError("Linux process ID changed during authentication");
  const commandEnd = stat.lastIndexOf(") ");
  if (commandEnd < 1) throw new TypeError("Linux process identity is malformed");
  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const startTime = fields[19];
  if (!/^(?:0|[1-9][0-9]*)$/.test(startTime ?? "")) {
    throw new TypeError("Linux process start time is malformed");
  }
  return `${processId},${startTime},${userId}`;
}

function execFileResult(execFile, command, args, timeout, mapResult) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout }, (error, stdout) => resolve(mapResult(error, stdout)));
  });
}

function createWcashDeviceOwnerVerifier() {
  let activeChallenge = null;

  async function runChallenge(invocation, withTimeout, timeout, onSettled = () => undefined) {
    if (activeChallenge !== null) return failed("device-auth-busy");
    const challenge = Promise.resolve().then(invocation);
    activeChallenge = challenge;
    const settle = () => {
      if (activeChallenge === challenge) activeChallenge = null;
      try {
        onSettled();
      } catch {
        // Cleanup must not change an authentication decision.
      }
    };
    challenge.then(settle, settle);
    return withTimeout(() => challenge, failed("device-auth-timeout"), timeout);
  }

  async function verifyWcashDeviceOwner({
    platform,
    reason,
    native,
    getWindow,
    execFile,
    readFileSync,
    userId,
    withTimeout,
    appId,
    processId,
    probeTimeoutMs,
    verifyTimeoutMs,
  }) {
    if (typeof withTimeout !== "function") throw new TypeError("withTimeout must be a function");
    if (
      !Number.isSafeInteger(probeTimeoutMs) ||
      probeTimeoutMs < 1 ||
      probeTimeoutMs > 30_000 ||
      !Number.isSafeInteger(verifyTimeoutMs) ||
      verifyTimeoutMs < 1 ||
      verifyTimeoutMs > 120_000
    ) {
      throw new TypeError("Device authentication timeouts are invalid");
    }

    if (platform === "win32") {
      let window = null;
      try {
        window = typeof getWindow === "function" ? getWindow() : null;
        if (
          !native ||
          typeof native.checkWindowsHello !== "function" ||
          typeof native.verifyWindowsUser !== "function"
        ) {
          return failed("device-auth-unavailable");
        }
        const availability = await withTimeout(() => native.checkWindowsHello(), "not_supported", probeTimeoutMs);
        if (availability !== "available") return failed("device-auth-unavailable");
        if (activeChallenge !== null) return failed("device-auth-busy");
        if (window) window.blur();
        const result = await runChallenge(
          () => native.verifyWindowsUser(String(reason)),
          withTimeout,
          verifyTimeoutMs,
          () => {
            if (window) window.focus();
          },
        );
        return challengeDecision(result);
      } catch {
        try {
          if (window) window.focus();
        } catch {
          // A closing window must not turn a denial into an exception.
        }
        return failed("device-auth-failed");
      }
    }

    if (platform === "darwin") {
      try {
        if (!native || typeof native.checkMacAuth !== "function" || typeof native.verifyMacUser !== "function") {
          return failed("device-auth-unavailable");
        }
        const availability = await withTimeout(() => native.checkMacAuth(), "not_supported", probeTimeoutMs);
        if (availability !== "available") return failed("device-auth-unavailable");
        return challengeDecision(
          await runChallenge(() => native.verifyMacUser(String(reason)), withTimeout, verifyTimeoutMs),
        );
      } catch {
        return failed("device-auth-failed");
      }
    }

    if (platform === "linux") {
      if (
        typeof execFile !== "function" ||
        typeof readFileSync !== "function" ||
        typeof appId !== "string" ||
        !/^[a-z0-9.-]{3,128}$/u.test(appId) ||
        !Number.isInteger(processId)
      ) {
        return failed("device-auth-unavailable");
      }
      try {
        const actionId = `${appId}.authenticate`;
        const processSubject = linuxProcessSubject(processId, userId, readFileSync);
        const availability = await withTimeout(
          () =>
            execFileResult(
              execFile,
              "/usr/bin/pkaction",
              ["--action-id", actionId],
              probeTimeoutMs,
              (_error, stdout) =>
                typeof stdout === "string" && stdout.split(/\r?\n/u).some((line) => line.trim() === actionId)
                  ? "available"
                  : "not_supported",
            ),
          "not_supported",
          probeTimeoutMs,
        );
        if (availability !== "available") return failed("device-auth-unavailable");

        const result = await runChallenge(
          () =>
            execFileResult(
              execFile,
              "/usr/bin/pkcheck",
              ["--action-id", actionId, "--process", processSubject, "--allow-user-interaction"],
              verifyTimeoutMs,
              (error) => ({ success: !error }),
            ),
          withTimeout,
          verifyTimeoutMs,
        );
        return challengeDecision(result);
      } catch {
        return failed("device-auth-failed");
      }
    }

    return failed("device-auth-unsupported");
  }

  return Object.freeze({ verify: verifyWcashDeviceOwner });
}

const defaultVerifier = createWcashDeviceOwnerVerifier();
const verifyWcashDeviceOwner = (options) => defaultVerifier.verify(options);

module.exports = { createWcashDeviceOwnerVerifier, linuxProcessSubject, verifyWcashDeviceOwner };
