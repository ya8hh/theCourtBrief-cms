// Keep build caches in the checkout when running inside a restricted environment.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = `${root}/.local/swc-cache`;
mkdirSync(cache, { recursive: true, mode: 0o700 });
const child = spawn(
  process.execPath,
  [
    `${root}/node_modules/@strapi/strapi/bin/strapi.js`,
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      SWC_NATIVE_BINDING_CACHE: process.env.SWC_NATIVE_BINDING_CACHE || cache,
      XDG_CONFIG_HOME: `${root}/.local/config`,
      XDG_CACHE_HOME: `${root}/.local/cache`,
      STRAPI_TELEMETRY_DISABLED: "true",
    },
    stdio: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
