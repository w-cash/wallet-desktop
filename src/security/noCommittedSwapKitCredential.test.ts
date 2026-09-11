import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";

const repositoryRoot = path.resolve(__dirname, "../..");
const thisTest = path.relative(repositoryRoot, __filename).replaceAll("\\", "/");

const trackedTextFiles = (): string[] =>
  execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => existsSync(path.join(repositoryRoot, file)))
    .filter((file) => /\.(?:cjs|js|jsx|json|mjs|ts|tsx)$/i.test(file));

describe("SwapKit credential hygiene", () => {
  it("does not restore the removed SwapKit secrets module", () => {
    expect(trackedTextFiles()).not.toContain("src/swap/swapKitSecrets.ts");
  });

  it("does not contain a hard-coded SwapKit API credential", () => {
    const credentialName = /\b(?:swapkit[\w]*(?:api_?key|token|secret)|(?:api_?key|token|secret)[\w]*swapkit)\b/i;
    const literalAssignment = /(?:=|:)\s*["'`][A-Za-z0-9+/_=.:-]{12,}["'`]/;

    const offenders = trackedTextFiles()
      .filter((file) => file !== thisTest)
      .filter((file) => {
        const source = readFileSync(path.join(repositoryRoot, file), "utf8");
        return source.split(/\r?\n/).some((line) => credentialName.test(line) && literalAssignment.test(line));
      });

    expect(offenders).toEqual([]);
  });
});
