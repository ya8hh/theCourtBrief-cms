import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export default (_: unknown, { strapi }: any) =>
  async (ctx: any, next: () => Promise<void>) => {
    // Manual uploads only: never fetch arbitrary remote URLs through Media Library.
    if (ctx.path === "/upload/actions/upload-from-urls")
      return ctx.badRequest(
        "Download the official PDF and upload the file directly.",
      );
    if (ctx.method === "DELETE" && /^\/upload\/files\/[^/]+$/.test(ctx.path)) {
      const id = Number(ctx.path.split("/").pop());
      const article = await strapi.db
        .query("api::case-article.case-article")
        .findOne({ where: { originalPdf: { id } } });
      const source = await strapi.db
        .query("api::source-document.source-document")
        .findOne({ where: { originalPdf: { id } } });
      if (article || source)
        return ctx.badRequest(
          "This PDF is attached to a record. Remove its references before deleting it.",
        );
    }
    const isUpload =
      ctx.path === "/upload" ||
      ctx.path === "/upload/" ||
      ctx.path === "/upload/files" ||
      /^\/upload\/files\/[^/]+\/replace$/.test(ctx.path);
    const files = ctx.request.files?.files;
    if (!isUpload || !files) return next();
    if (ctx.path.endsWith("/replace") || ctx.query.id)
      return ctx.badRequest(
        "Upload a new PDF and attach it to a draft. Replacing a source in place is disabled.",
      );
    const hashes = new Map<string, string>();
    for (const file of Array.isArray(files) ? files : [files]) {
      if (file.size > Number(process.env.MAX_UPLOAD_BYTES || 26214400))
        return ctx.throw(413, "PDF exceeds the upload limit.");
      const bytes = await readFile(file.filepath);
      if (
        file.mimetype !== "application/pdf" ||
        bytes.subarray(0, 5).toString() !== "%PDF-"
      )
        return ctx.badRequest("Upload a valid PDF with a PDF signature.");
      hashes.set(
        file.originalFilename,
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
    await next();
    if (ctx.status < 300 && Array.isArray(ctx.body))
      for (const file of ctx.body) {
        const sha = hashes.get(file.name);
        if (sha)
          await strapi.db.query("plugin::upload.file").update({
            where: { id: file.id },
            data: {
              provider_metadata: { ...file.provider_metadata, sha256: sha },
            },
          });
      }
  };
