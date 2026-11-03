import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 10087,
  token: null,
  extensionWaitMs: 29000,
  commandTimeoutMs: 120000,
  maxBodyBytes: 2 * 1024 * 1024,
  outputDir: os.tmpdir(),
  logLevel: "info",
});

export function homeDir() {
  return process.env.KAI_WEBRIDGE_HOME || path.join(os.homedir(), ".kai-webbridge");
}

export function configPath() {
  return path.join(homeDir(), "config.json");
}

export function pidPath() {
  return path.join(homeDir(), "daemon.pid");
}

export function addrPath() {
  return path.join(homeDir(), "daemon.addr");
}

export function logPath() {
  return path.join(homeDir(), "logs", "daemon.log");
}

export function ensureHome() {
  fs.mkdirSync(path.join(homeDir(), "logs"), { recursive: true });
}

export function readConfigFile(file = configPath()) {
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`cannot parse ${file}: expected a JSON object`);
  }
  return parsed;
}

function envConfig() {
  const env = {};
  if (process.env.KAI_WEBRIDGE_HOST) env.host = process.env.KAI_WEBRIDGE_HOST;
  if (process.env.KAI_WEBRIDGE_PORT) env.port = Number(process.env.KAI_WEBRIDGE_PORT);
  if (process.env.KAI_WEBRIDGE_TOKEN) env.token = process.env.KAI_WEBRIDGE_TOKEN;
  if (process.env.KAI_WEBRIDGE_OUTPUT_DIR) env.outputDir = process.env.KAI_WEBRIDGE_OUTPUT_DIR;
  if (process.env.KAI_WEBRIDGE_LOG_LEVEL) env.logLevel = process.env.KAI_WEBRIDGE_LOG_LEVEL;
  return env;
}

function validate(config) {
  const port = Number(config.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${config.port}`);
  }
  if (typeof config.host !== "string" || !config.host) {
    throw new Error("invalid host");
  }
  if (config.token != null && (typeof config.token !== "string" || config.token.length > 512)) {
    throw new Error("invalid token: expected a string under 512 characters");
  }
  for (const key of ["extensionWaitMs", "commandTimeoutMs", "maxBodyBytes"]) {
    const value = Number(config[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${key}`);
    config[key] = value;
  }
  if (!["silent", "error", "warn", "info", "debug"].includes(config.logLevel)) {
    throw new Error(`invalid logLevel: ${config.logLevel}`);
  }
  return config;
}

export function loadConfig(overrides = {}) {
  const merged = {
    ...DEFAULTS,
    ...readConfigFile(),
    ...envConfig(),
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
  if (merged.outputDir) merged.outputDir = path.resolve(String(merged.outputDir));
  return validate(merged);
}

export function statusUrl(config, pathname = "/status") {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}${pathname}`;
}

export function wsUrl(config) {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return `ws://${host}:${config.port}/ws`;
}
