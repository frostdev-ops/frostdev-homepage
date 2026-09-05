// Must be imported FIRST in every test file: db.ts reads HOMEPAGE_DATA_DIR at
// import time and caches the handle, so the env var has to exist before any
// src module is evaluated. Each test file runs in its own process, so one
// fresh temp dir per file gives full DB isolation.
import fs from 'node:fs';
import os from 'node:os';

process.env.TZ ??= 'UTC'; // pin local-time assertions (dailyClock, due dates) machine-independently
process.env.HOMEPAGE_DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/fdtest-');
process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
