import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  addrPath,
  configPath,
  ensureHome,
  homeDir,
  loadConfig,
  logPath,
  pidPath,
  statusUrl,
} from "./config.js";
import { Daemon } from "./daemon.js";
import { createLogger, sleep, waitFor } from "./util.js";
import { VERSION } from "./version.js";

const BIN_PATH = fileURLToPath(new URL("../bin/kai-webbridge.js", import.meta.url));
const SKILL_SOURCE = fileURLToPath(new URL("../skill/kai-webbridge", import.meta.url));
const EXTENSION_SOURCE = fileURLToPath(new URL("../extension", import.meta.url));

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { command: positionals[0], positionals: positionals.slice(1), flags };
}

function configOverrides(flags) {
  const overrides = {};
  if (flags.port !== undefined) overrides.port = Number(flags.port);
  if (flags.host !== undefined) overrides.host = String(flags.host);
  if (flags.token !== undefined) overrides.token = String(flags.token);
  if (flags["log-level"] !== undefined) overrides.logLevel = String(flags["log-level"]);
  if (flags["output-dir"] !== undefined) overrides.outputDir = String(flags["output-dir"]);
  return overrides;
}

async function fetchStatus(config, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(statusUrl(config), { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readAddr() {
  try {
    const raw = fs.readFileSync(addrPath(), "utf8").trim();
    const match = /^(.*):(\d+)$/.exec(raw);
    if (match) return { host: match[1], port: Number(match[2]) };
  } catch {
    /* no daemon record */
  }
  return null;
}

function withRuntimeAddr(config) {
  const addr = readAddr();
  if (!addr) return config;
  return { ...config, host: addr.host === "0.0.0.0" ? "127.0.0.1" : addr.host, port: addr.port };
}

function readPid() {
  try {
    return Number(fs.readFileSync(pidPath(), "utf8").trim());
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeRuntimeFiles() {
  await fsp.rm(pidPath(), { force: true });
  await fsp.rm(addrPath(), { force: true });
}

async function serve(config, { detached = false } = {}) {
  ensureHome();
  const logger = createLogger(config.logLevel);
  const daemon = new Daemon(config, { logger });
  await daemon.start();

  await fsp.writeFile(pidPath(), `${process.pid}\n`);
  await fsp.writeFile(addrPath(), `${config.host}:${daemon.port}\n`);

  if (!detached) {
    process.stdout.write(
      `Kai WebBridge daemon v${VERSION} listening on http://${config.host}:${daemon.port}\n` +
        `Extension WebSocket: ws://${config.host}:${daemon.port}/ws\n` +
        `Load the extension from ${fileURLToPath(new URL("../extension", import.meta.url))} (chrome://extensions → Load unpacked).\n`,
    );
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`shutting down (${signal})`);
    try {
      await daemon.stop();
    } finally {
      await removeRuntimeFiles();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return daemon;
}

async function startDaemon(config) {
  ensureHome();
  const existing = await fetchStatus(withRuntimeAddr(config));
  if (existing?.running) {
    process.stdout.write(`Kai WebBridge daemon already running on ${config.host}:${existing.port} (pid ${existing.pid})\n`);
    return;
  }

  const logFile = logPath();
  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "a");
  const args = [
    BIN_PATH,
    "serve",
    `--host=${config.host}`,
    `--port=${config.port}`,
    `--log-level=${config.logLevel}`,
  ];
  if (config.outputDir) args.push(`--output-dir=${config.outputDir}`);
  const env = { ...process.env };
  if (config.token) env.KAI_WEBRIDGE_TOKEN = config.token;

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
    cwd: process.cwd(),
  });
  child.unref();
  fs.closeSync(logFd);

  const status = await waitFor(() => fetchStatus(config, 800), { timeoutMs: 8000, intervalMs: 150 }).catch(
    () => null,
  );
  if (!status?.running) {
    const tail = await tailLog(30).catch(() => "");
    throw new Error(
      `daemon did not come up on ${config.host}:${config.port}. See ${logFile}\n${tail}`.trim(),
    );
  }
  process.stdout.write(
    `Kai WebBridge daemon started (pid ${status.pid}) on http://${config.host}:${status.port}\n` +
      `Logs: ${logFile}\n`,
  );
}

async function stopDaemon(config) {
  const runtimeConfig = withRuntimeAddr(config);
  const pid = readPid();
  if (!pidAlive(pid)) {
    await removeRuntimeFiles();
    const status = await fetchStatus(runtimeConfig);
    if (status?.running) {
      throw new Error(`a daemon is running on ${runtimeConfig.host}:${runtimeConfig.port} but ${pidPath()} is missing or stale`);
    }
    process.stdout.write("Kai WebBridge daemon is not running\n");
    return;
  }
  process.kill(pid, "SIGTERM");
  const stopped = await waitFor(async () => !pidAlive(pid) || !(await fetchStatus(runtimeConfig)), {
    timeoutMs: 6000,
    intervalMs: 150,
  }).catch(() => false);
  await removeRuntimeFiles();
  if (!stopped) throw new Error(`daemon ${pid} did not exit within 6s`);
  process.stdout.write(`Kai WebBridge daemon stopped (pid ${pid})\n`);
}

async function showStatus(config) {
  const status = await fetchStatus(withRuntimeAddr(config));
  if (status) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  const addr = withRuntimeAddr(config);
  process.stdout.write(
    `${JSON.stringify({ service: "kai-webbridge", running: false, addr: `${addr.host}:${addr.port}` })}\n`,
  );
}

async function tailLog(lines = 50) {
  const content = await fsp.readFile(logPath(), "utf8");
  const rows = content.trimEnd().split("\n");
  return rows.slice(-lines).join("\n");
}

async function showLogs(flags) {
  const count = Number(flags.n ?? flags.lines ?? 50);
  process.stdout.write(`${await tailLog(Number.isFinite(count) ? count : 50)}\n`);
  if (flags.f || flags.follow) {
    let offset = (await fsp.stat(logPath())).size;
    for (;;) {
      await sleep(500);
      const stat = await fsp.stat(logPath()).catch(() => null);
      if (!stat) continue;
      if (stat.size > offset) {
        const fd = await fsp.open(logPath(), "r");
        const buffer = Buffer.alloc(stat.size - offset);
        await fd.read(buffer, 0, buffer.length, offset);
        await fd.close();
        process.stdout.write(buffer.toString("utf8"));
        offset = stat.size;
      }
    }
  }
}

async function installSkill(flags) {
  const targets = [];
  const ownSkill = path.join(homeDir(), "skills", "kai-webbridge");
  targets.push(ownSkill);
  const agents = [
    [".claude", "Claude Code"],
    [".codex", "Codex"],
  ];
  for (const [dir] of agents) {
    const base = path.join(os.homedir(), dir);
    if (fs.existsSync(base)) targets.push(path.join(base, "skills", "kai-webbridge"));
  }
  for (const target of targets) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.cp(SKILL_SOURCE, target, { recursive: true, force: true });
    process.stdout.write(`installed skill → ${target}\n`);
  }
  if (flags.check) {
    process.stdout.write(`skill source: ${SKILL_SOURCE}\n`);
  }
}

async function installExtension() {
  const target = path.join(homeDir(), "extension");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.cp(EXTENSION_SOURCE, target, { recursive: true, force: true });
  return target;
}

async function setup(config, flags) {
  ensureHome();
  process.stdout.write(`Kai WebBridge v${VERSION} setup\n\n`);
  const extensionPath = await installExtension();
  if (flags["no-skill"]) {
    process.stdout.write("skipped skill install (--no-skill)\n");
  } else {
    await installSkill(flags);
  }
  if (flags["no-start"]) {
    process.stdout.write("skipped daemon start (--no-start)\n");
  } else {
    await startDaemon(config);
  }
  const runtimeConfig = withRuntimeAddr(config);
  const status = await fetchStatus(runtimeConfig);
  process.stdout.write(`\nDaemon:    http://${runtimeConfig.host}:${runtimeConfig.port}`);
  process.stdout.write(status?.running ? ` (running, pid ${status.pid})\n` : " (not running)\n");
  process.stdout.write(`Extension: ${extensionPath}\n\n`);
  if (config.token) {
    process.stdout.write(`Token:     required — set the same token in the extension options page\n`);
  }
  if (runtimeConfig.port !== 10087) {
    process.stdout.write(
      `Note:      the extension defaults to ws://127.0.0.1:10087/ws; set ws://127.0.0.1:${runtimeConfig.port}/ws in its options\n`,
    );
  }
  process.stdout.write("\n");
  if (status?.extension_connected) {
    process.stdout.write(
      `Extension is connected. Try:\n  curl -s http://${runtimeConfig.host}:${runtimeConfig.port}/status\n`,
    );
    return;
  }
  process.stdout.write(
    "One manual step remains (Chrome only allows extension loading from its UI):\n" +
      "  1. Open chrome://extensions\n" +
      "  2. Turn on Developer mode\n" +
      '  3. Click "Load unpacked" and select the Extension folder above\n\n' +
      "Then verify with: kai-webbridge status\n",
  );
}

function helpText() {
  return `Kai WebBridge v${VERSION} — drive your real Chrome from a local agent

Usage:
  kai-webbridge <command> [options]

Commands:
  setup                 One-time setup: skill, extension copy, daemon start
  start                 Start the daemon in the background
  stop                  Stop the background daemon
  restart               Restart the daemon
  serve                 Run the daemon in the foreground
  status                Print daemon status JSON
  logs [-n N] [-f]      Show or follow daemon logs
  install-skill         Install the agent skill into detected runtimes
  version               Print the version
  help                  Show this help

Options:
  --host <host>         Bind address (default 127.0.0.1)
  --port <port>         Port (default 10087)
  --token <token>       Require this bearer token for commands and the extension
  --output-dir <dir>    Directory for screenshots and PDFs (default: OS temp dir)
  --log-level <level>   silent|error|warn|info|debug (default info)

Setup options:
  --no-start            Do not start the daemon
  --no-skill            Do not install the agent skill

Config file: ${configPath()}
Data dir:    ${homeDir()}
`;
}

export async function main(argv) {
  const { command, flags } = parseArgs(argv);
  if (!command || command === "help" || flags.help) {
    process.stdout.write(helpText());
    return;
  }
  if (command === "version" || command === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (flags.home) process.env.KAI_WEBRIDGE_HOME = path.resolve(String(flags.home));
  const config = loadConfig(configOverrides(flags));

  switch (command) {
    case "serve":
      await serve(config);
      return;
    case "setup":
      await setup(config, flags);
      return;
    case "start":
      await startDaemon(config);
      return;
    case "stop":
      await stopDaemon(config);
      return;
    case "restart":
      await stopDaemon(config);
      await startDaemon(config);
      return;
    case "status":
      await showStatus(config);
      return;
    case "logs":
      await showLogs(flags);
      return;
    case "install-skill":
      await installSkill(flags);
      return;
    default:
      throw new Error(`unknown command "${command}". Run 'kai-webbridge help'.`);
  }
}
