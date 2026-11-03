import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const VERSION = pkg.version;
export const PROTOCOL_VERSION = 1;
export const SERVICE_NAME = "kai-webbridge";
