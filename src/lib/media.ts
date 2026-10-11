import { createHmac, timingSafeEqual } from "node:crypto";
const key = () => {
  if (!process.env.MEDIA_SIGNING_KEY)
    throw new Error("Missing media signing key");
  return process.env.MEDIA_SIGNING_KEY;
};
const digest = (path: string, expires: string) =>
  createHmac("sha256", key()).update(`${path}\n${expires}`).digest("hex");
export function signMediaUrl(path: string, now = Date.now()) {
  path = new URL(path, "http://localhost").pathname;
  const expires = String(Math.floor(now / 1000) + 300);
  return `${path}?expires=${expires}&signature=${digest(path, expires)}`;
}
export function verifyMediaUrl(
  path: string,
  expires: unknown,
  signature: unknown,
  now = Date.now(),
): boolean {
  if (
    typeof expires !== "string" ||
    typeof signature !== "string" ||
    !/^\d+$/.test(expires) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const expiry = Number(expires);
  if (expiry < now / 1000 || expiry > now / 1000 + 301) return false;
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(digest(path, expires), "hex"),
  );
}
