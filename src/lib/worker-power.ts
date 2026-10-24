import { timingSafeEqual } from "node:crypto";

export const powerEnabled = () => process.env.WORKER_ON_DEMAND === "true";
export async function powerLock(trx: any) {
  await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", ["court-worker-power"]);
}
export function powerAuth(ctx: any) {
  const expected = process.env.WORKER_POWER_TOKEN || "";
  const supplied = String(ctx.request.headers.authorization || "").replace(/^Bearer /, "");
  if (!powerEnabled()) ctx.throw(404, "On-demand worker control is disabled.");
  if (expected.length < 32 || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
    ctx.throw(401, "Invalid worker controller authorization.");
}
export async function powerState(db: any, action: string, now = new Date()) {
  if (!["inspect", "drain", "resume"].includes(action)) throw new Error("Invalid power action.");
  return db.transaction(async (trx: any) => {
    await powerLock(trx);
    const state = await trx("worker_power_state").where({ id: 1 }).first();
    if (!state) throw new Error("Worker power migration is missing.");
    // Include every running lease: do not shut down extraction or generation in flight.
    const busy = Boolean(await trx("processing_jobs").where((q: any) => q
      .whereIn("state", ["queued", "running"])
      .orWhere((q: any) => q.where("state", "waiting").where("next_run_at", "<=", now)))
      .first("id"));
    let idleSince = busy ? null : state.idle_since || now;
    let mode = state.mode;
    const configured = Number(process.env.WORKER_IDLE_SECONDS || 600);
    const idleSeconds = Number.isFinite(configured) ? Math.min(3600, Math.max(60, configured)) : 600;
    const idleLongEnough = !busy && now.getTime() - new Date(idleSince).getTime() >= idleSeconds * 1000;
    if (action === "resume") { mode = "active"; idleSince = null; }
    if (action === "drain" && idleLongEnough) mode = "draining";
    await trx("worker_power_state").where({ id: 1 }).update({ mode, idle_since: idleSince });
    return { busy, mode, canStop: !busy && mode === "draining" && idleLongEnough,
      idleSeconds, idleSince };
  });
}
