import { purgePublishedPdfs } from "./lib/pdf-retention";
import { registerEditorial } from "./editorial";
import type { Core } from "@strapi/strapi";
import { signMediaUrl } from "./lib/media";
import { errors } from "@strapi/utils";
import { validatePublication, canApprove } from "./lib/publication";
const UID = "api::case-article.case-article" as const;
const editorialFields = [
  "headline",
  "slug",
  "summary",
  "subtitle",
  "articleBody",
  "seoTitle",
  "seoDescription",
  "legalIssues",
  "importantParagraphReferences",
  "originalPdf",
  "sourceDocument",
  "officialSourceUrl",
  "pdfUnavailableReason",
  "caseTitle",
  "caseNumber",
  "diaryNumber",
  "judgmentDate",
  "bench",
  "judges",
  "keyHoldings",
  "finalOutcome",
  "author",
  "statutoryProvisions",
  "legalTopics",
  "documentType",
  "category",
];
export default {
  register({ strapi }: { strapi: Core.Strapi }) {
    registerEditorial(strapi);
    strapi.documents.use(async (context, next) => {
      if (context.uid === "api::source-document.source-document") {
        const params = context.params as any,
          data = params.data;
        const actor = strapi.requestContext.get()?.state?.user;
        if (data) {
          delete data.pdfRetiredAt;
          if (context.action === "create" && !data.originalPdf)
            throw new errors.ValidationError(
              "Upload or import a court PDF first.",
            );
          if (data.allowMultipleArticles === true && !canApprove(actor))
            throw new errors.ForbiddenError(
              "Only a publisher may authorize source reuse.",
            );
          if (data.originalPdf) {
            const relation = data.originalPdf;
            const id =
              typeof relation === "number" || typeof relation === "string"
                ? relation
                : (relation.id ??
                  relation.set?.[0]?.id ??
                  relation.connect?.[0]?.id ??
                  relation.connect?.[0]);
            if (!id)
              throw new errors.ValidationError("Select an uploaded PDF.");
            const file = await strapi.db
              .query("plugin::upload.file")
              .findOne({ where: { id } });
            if (
              file?.mime !== "application/pdf" ||
              !file?.provider_metadata?.sha256
            )
              throw new errors.ValidationError(
                "Upload a verified PDF through the Media Library first.",
              );
            if (
              params.documentId &&
              (await strapi.db
                .connection("processing_jobs")
                .where("source_id", params.documentId)
                .whereIn("state", ["queued", "running", "waiting"])
                .first())
            )
              throw new errors.ValidationError(
                "Wait for source processing to finish before replacing its PDF.",
              );
            data.extractedText = null;
            data.extractionMetadata = null;
            data.textReviewed = false;
            data.ocrRequired = false;
            data.processingStatus = "uploaded";
            data.documentSha256 = file.provider_metadata.sha256;
            data.originalFilename = file.name;
            const duplicate = await strapi.db
              .query("api::source-document.source-document")
              .findOne({
                where: {
                  documentSha256: data.documentSha256,
                  documentId: { $ne: params.documentId || "" },
                },
              });
            if (duplicate)
              throw new errors.ValidationError(
                `Duplicate source document: open existing record ${duplicate.documentId}.`,
              );
          } else {
            delete data.documentSha256;
            delete data.originalFilename;
          }
        }
        return next();
      }
      if (context.uid !== UID) return next();
      const { action } = context;
      if (
        ![
          "create",
          "update",
          "publish",
          "unpublish",
          "delete",
          "discardDraft",
        ].includes(action)
      )
        return next();
      const params = context.params as any;
      return strapi.db.transaction(async ({ trx, onCommit }) => {
        if (params.documentId)
          await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
            params.documentId,
          ]);
        const actor = strapi.requestContext.get()?.state?.user;
        const data = params.data;
        const old = params.documentId
          ? await strapi.documents(UID).findOne({
              documentId: params.documentId,
              status: "draft",
              populate: ["originalPdf", "sourceDocument"],
            })
          : null;
        if (data && old && action === "update") {
          const snapshot = {
            ...old,
            originalPdf: (old as any).originalPdf?.id ?? null,
            sourceDocument: (old as any).sourceDocument?.documentId ?? null,
          };
          await trx("article_versions").insert({
            document_id: params.documentId,
            snapshot: JSON.stringify(snapshot),
            actor_id: String(actor?.id || "system"),
            created_at: new Date(),
          });
        }
        if (data) {
          delete data.pdfRetiredAt;
          if (data.sourceDocument) {
            const sourceId =
              typeof data.sourceDocument === "string"
                ? data.sourceDocument
                : data.sourceDocument?.documentId;
            if (sourceId) {
              const linked: any = await strapi
                .documents("api::source-document.source-document")
                .findOne({ documentId: sourceId });
              data.sourceSearchText = linked?.textReviewed
                ? linked.extractedText
                : null;
            }
          }
          if (data.slug) {
            await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
              `article-slug:${data.slug}`,
            ]);
            const conflict = await strapi.db.query(UID).findOne({
              where: {
                slug: data.slug,
                documentId: { $ne: params.documentId || "" },
              },
            });
            if (conflict)
              throw new errors.ValidationError(
                "This slug belongs to another article. Choose a unique slug.",
              );
          }
          delete data.approvedBy;
          delete data.approvedOn;
          delete data.publishedBy;
          const relationId = (v: any) =>
            v?.id ??
            v?.set?.[0]?.id ??
            v?.connect?.[0]?.id ??
            v?.connect?.[0] ??
            v ??
            null;
          const changed =
            old &&
            editorialFields.some(
              (k) =>
                k in data &&
                (["originalPdf", "sourceDocument"].includes(k)
                  ? String(relationId(data[k])) !==
                    String(relationId((old as any)[k]))
                  : JSON.stringify(data[k] ?? null) !==
                    JSON.stringify((old as any)[k] ?? null)),
            );
          if (changed) {
            data.reviewStatus = "draft";
            data.approvedBy = null;
            data.approvedOn = null;
          }
          data.workflowState =
            data.reviewStatus ||
            (changed ? "draft" : old?.reviewStatus || "draft");
          if (data.reviewStatus === "approved") {
            if (!canApprove(actor))
              throw new errors.ForbiddenError(
                "Only a publisher may approve an article.",
              );
            if (!old || old.reviewStatus !== "review")
              throw new errors.ValidationError(
                "Submit the saved draft for review before approving it.",
              );
            data.approvedBy = String(actor.id);
            data.approvedOn = new Date().toISOString();
          }
        }
        if (
          action === "publish" ||
          (["create", "update"].includes(action) &&
            params.status === "published")
        ) {
          if (!canApprove(actor))
            throw new errors.ForbiddenError(
              "Only a publisher may publish an article.",
            );
          // Separate save, approve, publish steps avoid approving unseen edits in one request.
          if (data || !old)
            throw new errors.ValidationError(
              "Save the draft, approve it, then publish.",
            );
          validatePublication(old);
          const pdf = (old as any).originalPdf;
          if (pdf && !pdf.provider_metadata?.sha256)
            throw new errors.ValidationError(
              "The original PDF must pass upload signature validation.",
            );
          if (pdf)
            await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
              pdf.provider_metadata.sha256,
            ]);
          const matchingFiles = pdf
            ? await trx("files")
                .whereRaw("provider_metadata->>'sha256' = ?", [
                  pdf.provider_metadata.sha256,
                ])
                .select("id")
            : [];
          const duplicate = pdf
            ? await strapi.documents(UID).count({
                status: "published",
                filters: {
                  originalPdf: {
                    id: { $in: matchingFiles.map((f: any) => f.id) },
                  },
                  documentId: { $ne: params.documentId },
                },
              } as any)
            : 0;
          if (duplicate && !(old as any).sourceDocument?.allowMultipleArticles)
            throw new errors.ValidationError(
              "This PDF is already published. Link an explicitly authorized reusable source document.",
            );
          const source = (old as any).sourceDocument;
          if (
            source &&
            pdf &&
            source.documentSha256 !== pdf.provider_metadata.sha256
          )
            throw new errors.ValidationError(
              "The article PDF must match its source document.",
            );
          if (source && !source.allowMultipleArticles) {
            const other = await strapi.documents(UID).count({
              status: "published",
              filters: {
                sourceDocument: { documentId: source.documentId },
                documentId: { $ne: params.documentId },
              },
            } as any);
            if (other)
              throw new errors.ValidationError(
                "This source already has a published article. A publisher must explicitly authorize reuse.",
              );
          }
        }
        const result = await next();
        if (action === "publish")
          onCommit(() => {
            void purgePublishedPdfs(strapi);
          });
        if (action === "publish")
          await strapi.db.query(UID).updateMany({
            where: { documentId: params.documentId },
            data: { publishedBy: String(actor.id), workflowState: "published" },
          });
        if (
          ["publish", "unpublish"].includes(action) &&
          (old as any)?.sourceDocument?.documentId
        ) {
          const sid = (old as any).sourceDocument.documentId;
          const published = await strapi.documents(UID).count({
            status: "published",
            filters: { sourceDocument: { documentId: sid } },
          } as any);
          await strapi
            .documents("api::source-document.source-document")
            .update({
              documentId: sid,
              data: {
                processingStatus: published ? "published" : "ready_for_review",
              },
            } as any);
        }
        if (action === "unpublish")
          await strapi.db.query(UID).updateMany({
            where: { documentId: params.documentId },
            data: { workflowState: old?.reviewStatus || "draft" },
          });
        if (params.documentId || (result as any)?.documentId) {
          await trx("editorial_audit_events").insert({
            document_id: params.documentId || (result as any)?.documentId,
            action: data?.reviewStatus === "approved" ? "approve" : action,
            actor_id: actor?.id ? String(actor.id) : "system",
            occurred_at: new Date(),
          });
        }
        return result;
      });
    });
  },
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    strapi.cron.add({
      temporaryPdfs: {
        task: () => purgePublishedPdfs(strapi),
        options: { rule: "*/30 * * * * *" },
      },
    });
    const provider = strapi.plugin("upload").provider;
    if (strapi.config.get("plugin::upload.provider", "local") === "local") {
      if (!process.env.MEDIA_SIGNING_KEY)
        throw new Error("MEDIA_SIGNING_KEY is required");
      provider.isPrivate = async () => true;
      provider.getSignedUrl = async (file: any) => ({
        url: signMediaUrl(file.url),
      });
    }
    // Add deployment indexes after Strapi has synchronized content-type tables.
    await strapi.db.connection.raw(
      "CREATE INDEX IF NOT EXISTS case_articles_published_idx ON case_articles (published_at DESC) WHERE published_at IS NOT NULL",
    );
    await strapi.db.connection.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS case_articles_published_slug_idx ON case_articles (slug) WHERE published_at IS NOT NULL",
    );
    await strapi.db.connection.raw(
      `CREATE INDEX IF NOT EXISTS case_articles_search_v2_idx ON case_articles USING GIN (to_tsvector('english',coalesce(headline,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(case_title,'') || ' ' || coalesce(case_number,'') || ' ' || coalesce(bench,'') || ' ' || coalesce(judges::text,'') || ' ' || coalesce(legal_topics::text,'') || ' ' || coalesce(statutory_provisions::text,'') || ' ' || coalesce(source_search_text,''))) WHERE published_at IS NOT NULL`,
    );
    const roleService = strapi.service("admin::role");
    for (const role of [
      {
        name: "Court Reporter",
        code: "court-reporter",
        description:
          "Create and edit drafts; cannot approve, publish or delete.",
      },
      {
        name: "Court Publisher",
        code: "court-publisher",
        description:
          "Review, approve and publish articles; manage source documents.",
      },
    ]) {
      if (
        await strapi.db
          .query("admin::role")
          .findOne({ where: { code: role.code } })
      )
        continue;
      const created = await roleService.create(role);
      const permissions: any[] = [];
      for (const subject of [UID, "api::source-document.source-document"]) {
        const schema = (strapi.contentTypes as any)[subject];
        const fieldNames = Object.keys(schema.attributes).filter(
          (k) =>
            ![
              "id",
              "documentId",
              "createdAt",
              "updatedAt",
              "publishedAt",
              "createdBy",
              "updatedBy",
              "localizations",
              "locale",
              "approvedBy",
              "approvedOn",
              "publishedBy",
            ].includes(k),
        );
        if (role.code === "court-reporter")
          for (const f of ["allowMultipleArticles"]) {
            const i = fieldNames.indexOf(f);
            if (i >= 0) fieldNames.splice(i, 1);
          }
        for (const operation of [
          "read",
          "create",
          "update",
          ...(role.code === "court-publisher" && subject === UID
            ? ["publish"]
            : []),
        ])
          permissions.push({
            action: `plugin::content-manager.explorer.${operation}`,
            subject,
            properties: { fields: fieldNames },
            conditions: [],
          });
      }
      for (const action of [
        "plugin::upload.read",
        "plugin::upload.assets.create",
        "plugin::upload.assets.update",
      ])
        permissions.push({
          action,
          subject: null,
          properties: {},
          conditions: [],
        });
      await roleService.assignPermissions(created.id, permissions);
    }
  },
};
