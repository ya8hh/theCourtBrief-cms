import type { Core } from "@strapi/strapi";
const ARTICLE = "api::case-article.case-article" as const;
let cleaning = false;
export async function purgePublishedPdfs(strapi: Core.Strapi) {
  if (cleaning) return;
  cleaning = true;
  try {
    const rows: any[] = await strapi.documents(ARTICLE).findMany({
      status: "published",
      populate: ["originalPdf"],
      filters: { originalPdf: { id: { $notNull: true } } },
      limit: 100,
    } as any);
    for (const row of rows) {
      const file = row.originalPdf;
      const drafts: any[] = await strapi.documents(ARTICLE).findMany({
        status: "draft",
        filters: { originalPdf: { id: file.id } },
        populate: ["sourceDocument"],
        limit: 100,
      } as any);
      const published: any[] = await strapi.documents(ARTICLE).findMany({
        status: "published",
        filters: { originalPdf: { id: file.id } },
        limit: 100,
      } as any);
      if (
        drafts.some(
          (d) => !published.some((p) => p.documentId === d.documentId),
        )
      )
        continue;
      const sources: any[] = await strapi.db
        .query("api::source-document.source-document")
        .findMany({ where: { originalPdf: { id: file.id } } });
      const active =
        sources.length &&
        (await strapi.db
          .connection("processing_jobs")
          .whereIn(
            "source_id",
            sources.map((s) => s.documentId),
          )
          .whereIn("state", ["queued", "running", "waiting"])
          .first());
      if (active) continue;
      const stamp = new Date().toISOString();
      // Retain provenance and publication eligibility before removing media relations.
      await strapi.db.query(ARTICLE).updateMany({
        where: { documentId: { $in: published.map((p) => p.documentId) } },
        data: { pdfRetiredAt: stamp },
      });
      await strapi.plugin("upload").service("upload").remove(file);
      for (const source of sources)
        await strapi.db
          .query("api::source-document.source-document")
          .update({ where: { id: source.id }, data: { pdfRetiredAt: stamp } });
      await strapi.db.connection("editorial_audit_events").insert({
        document_id: row.documentId,
        action: "delete-temporary-pdf",
        actor_id: "system",
        occurred_at: new Date(),
      });
    }
  } catch (error) {
    strapi.log.error(
      "Temporary PDF cleanup failed; the scheduled cleanup will retry.",
      error,
    );
  } finally {
    cleaning = false;
  }
}
