#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`kai-webbridge: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
