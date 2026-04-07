const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  npmCommand,
  parseEmulatorArgs,
  prepareEmulator,
} = require("./me-emulator-lib");

function helpText() {
  return [
    "Usage: node scripts/launch-me-emulator.js [options]",
    "",
    "Options:",
    "  --profile <missing|broken-config|ready|slow|fail>",
    "  --seed <demo|empty>",
    "  --keep-sandbox",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--help")) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  const options = parseEmulatorArgs(argv);
  const prepared = await prepareEmulator(options);

  process.stdout.write(
    [
      "Me Emulator",
      `Profile: ${prepared.profileLabel}`,
      `Seed: ${prepared.seed}`,
      `Sandbox root: ${prepared.sandboxRoot}`,
      `Home override: ${prepared.homeDir}`,
      `Data override: ${prepared.dataDir}`,
      options.keepSandbox
        ? "Sandbox will be kept after exit."
        : "Sandbox is disposable. If you want to inspect it later, rerun with --keep-sandbox.",
      "Close the app window or press Ctrl+C to end the emulator.",
      "",
    ].join("\n"),
  );

  const child = spawn(npmCommand(), ["run", "dev"], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
    env: prepared.env,
  });

  child.on("exit", (code, signal) => {
    const finish = () => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      process.exit(code ?? 0);
    };

    if (options.keepSandbox) {
      finish();
      return;
    }

    fs.rm(prepared.sandboxRoot, { recursive: true, force: true })
      .catch(() => {})
      .finally(finish);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
