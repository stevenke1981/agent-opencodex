#!/usr/bin/env node
import { main } from "../src/cli.mjs";
const exitCode = await main();
process.exitCode = exitCode;
