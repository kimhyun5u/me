const { spawn } = require("node:child_process");
const path = require("node:path");

const {
  npmCommand,
  prepareCodexScenario,
} = require("./me-emulator-lib");

async function main() {
  const scenario = process.argv[2];

  if (!scenario) {
    throw new Error("Missing scenario name.");
  }

  const prepared = await prepareCodexScenario(scenario);
  process.stdout.write(
    [
      `Scenario: ${scenario}`,
      `Sandbox root: ${prepared.sandboxRoot}`,
      `Home override: ${prepared.homeDir}`,
      `Data override: ${prepared.dataDir}`,
      "Close the app window or press Ctrl+C to end the scenario.",
      "",
    ].join("\n"),
  );

  const child = spawn(npmCommand(), ["run", "dev"], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
    env: prepared.env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
