#!/usr/bin/env node
import { main } from '../src/cli.js';
import { realDeps } from '../src/deps.js';
import { quietPipes } from '../src/epipe.js';

quietPipes([process.stdout, process.stderr]);
process.exitCode = await main(process.argv.slice(2), realDeps());
