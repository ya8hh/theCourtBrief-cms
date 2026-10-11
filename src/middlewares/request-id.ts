import { randomUUID } from "node:crypto";
export default () => async (ctx: any, next: () => Promise<void>) => {
  const supplied = ctx.get("X-Request-Id");
  const id = /^[a-zA-Z0-9-]{8,80}$/.test(supplied) ? supplied : randomUUID();
  ctx.state.requestId = id;
  ctx.set("X-Request-Id", id);
  await next();
};
