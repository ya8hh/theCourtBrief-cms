import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(root + ".env")) throw new Error(".env exists; refusing to overwrite.");
let body = readFileSync(root + ".env.example", "utf8");
for (const key of ["ADMIN_JWT_SECRET","API_TOKEN_SALT","TRANSFER_TOKEN_SALT","ENCRYPTION_KEY","MEDIA_SIGNING_KEY","PROCESSOR_TOKEN"])
  body = body.replace(new RegExp("^" + key + "=.*$", "m"), key + "=" + randomBytes(32).toString("hex"));
body = body.replace(/^APP_KEYS=.*$/m, "APP_KEYS=" + randomBytes(32).toString("hex") + "," + randomBytes(32).toString("hex"));
writeFileSync(root + ".env", body, { mode: 0o600 });
console.log("Created .env with fresh secrets. Set your database credentials and service URLs before starting.");
