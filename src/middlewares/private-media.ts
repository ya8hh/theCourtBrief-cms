import { verifyMediaUrl } from "../lib/media";
export default (_config: unknown, { strapi }: any) =>
  async (ctx: any, next: () => Promise<void>) => {
    if (!ctx.path.startsWith("/uploads/")) return next();
    const file = await strapi.db
      .query("plugin::upload.file")
      .findOne({ where: { url: ctx.path } });
    if (!file) return ctx.notFound();
    const published = await strapi.db
      .query("api::case-article.case-article")
      .findOne({
        where: {
          publishedAt: { $notNull: true },
          originalPdf: { id: file.id },
        },
      });
    if (
      !published &&
      !verifyMediaUrl(ctx.path, ctx.query.expires, ctx.query.signature)
    )
      return ctx.notFound();
    ctx.set("Cache-Control", "no-store");
    ctx.set("Content-Disposition", "attachment");
    return next();
  };
