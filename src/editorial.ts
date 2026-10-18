import {
  credentialColumns,
  credentialInput,
  encryptCredential,
  workerCredentialConfig,
} from "./lib/ai-credentials";
import { importOfficialPdf } from "./lib/import-pdf";
import type { Core } from "@strapi/strapi";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import Ajv from "ajv";
import { errors } from "@strapi/utils";
import {
  canApprove,
  validatePublication,
  isOfficialSource,
} from "./lib/publication";
const ARTICLE = "api::case-article.case-article" as const;
const SOURCE = "api::source-document.source-document" as const;
const editable = [
  "headline",
  "slug",
  "subtitle",
  "summary",
  "articleBody",
  "category",
  "documentType",
  "caseTitle",
  "caseNumber",
  "diaryNumber",
  "judgmentDate",
  "bench",
  "judges",
  "legalIssues",
  "legalTopics",
  "statutoryProvisions",
  "keyHoldings",
  "finalOutcome",
  "importantParagraphReferences",
  "officialSourceUrl",
  "pdfUnavailableReason",
  "originalPdf",
  "sourceDocument",
  "author",
  "seoTitle",
  "seoDescription",
  "editorialNotes",
];
const pick = (data: any, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
const decode = (row: any) => {
  if (!row) return row;
  const out = { ...row };
  for (const key of ["payload", "result", "snapshot", "checkpoint", "progress"])
    if (typeof out[key] === "string") out[key] = JSON.parse(out[key]);
  return out;
};
const bad = (message: string): never => {
  throw new errors.ValidationError(message);
};
export function registerEditorial(strapi: Core.Strapi) {
  const db = strapi.db.connection;
  const article = (id: string) =>
    strapi.documents(ARTICLE).findOne({
      documentId: id,
      status: "draft",
      populate: ["sourceDocument", "originalPdf"],
    } as any) as Promise<any>;
  const source = (id: string) =>
    strapi.documents(SOURCE).findOne({
      documentId: id,
      populate: ["originalPdf"],
    } as any) as Promise<any>;
  const audit = (
    id: string,
    action: string,
    actor: any,
    connection: any = db,
  ) =>
    connection("editorial_audit_events").insert({
      document_id: id,
      action,
      actor_id: String(actor?.id || "worker"),
      occurred_at: new Date(),
    });
  const present = async (row: any) => {
    if (row?.originalPdf) {
      const signed = await strapi
        .plugin("upload")
        .provider.getSignedUrl(row.originalPdf);
      return { ...row, originalPdf: { ...row.originalPdf, url: signed.url } };
    }
    return row;
  };
  const actor = (ctx: any) => {
    const user = ctx.state.user;
    if (
      !user?.roles?.some((r: any) =>
        ["strapi-super-admin", "court-reporter", "court-publisher"].includes(
          r.code,
        ),
      )
    )
      throw new errors.ForbiddenError("An editorial role is required.");
    ctx.set("Cache-Control", "no-store");
    return user;
  };
  const requireKeyAdmin = (ctx: any) => {
    if (
      !ctx.state.user?.roles?.some((r: any) => r.code === "strapi-super-admin")
    )
      throw new errors.ForbiddenError(
        "Only a CMS super administrator can manage AI credentials.",
      );
  };
  const current = async (ctx: any) => {
    const row = await article(ctx.params.id);
    if (!row) {
      ctx.throw(404, "Draft not found.");
    }
    if (ctx.request.body?.expectedUpdatedAt !== row.updatedAt)
      ctx.throw(409, "This draft changed. Reload before saving.");
    return row;
  };
  const enqueue = async (
    s: any,
    kind: string,
    payload: any,
    user: any,
    checkpoint: any = null,
  ) => {
    if (!["extract", "generate", "revise"].includes(kind))
      bad("Invalid job kind.");
    if (kind !== "extract" && (s.ocrRequired || !s.extractedText))
      bad(
        "The PDF must finish processing and all pages must be readable before generation.",
      );
    if (kind === "generate" && !payload.force) {
      const cached = decode(
        await db("processing_jobs")
          .where({ source_id: s.documentId, kind, state: "succeeded" })
          .orderBy("created_at", "desc")
          .first(),
      );
      if (
        cached?.payload?.checksum === s.documentSha256 &&
        cached?.result?.draft
      )
        return cached.id;
    }
    const id = randomUUID();
    try {
      await db.transaction(async (trx: any) => {
        await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
          "editor-job-budget:" + user.id,
        ]);
        const recent = await trx("processing_jobs")
          .where("requested_by", String(user.id))
          .where("created_at", ">", new Date(Date.now() - 3600000))
          .count("* as n")
          .first();
        if (
          Number(recent?.n) +
            (kind === "extract" && payload.autoGenerate ? 2 : 1) >
          30
        )
          bad("Hourly processing limit reached. Try again later.");
        await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
          "source-job:" + s.documentId,
        ]);
        if (
          await trx("processing_jobs")
            .where("source_id", s.documentId)
            .whereIn("state", ["queued", "running", "waiting"])
            .first()
        )
          bad("A source processing job is already queued or running.");
        await trx("processing_jobs").insert({
          id,
          source_id: s.documentId,
          kind,
          state: "queued",
          checkpoint: checkpoint ? JSON.stringify(checkpoint) : null,
          payload: JSON.stringify({ ...payload, checksum: s.documentSha256 }),
          requested_by: String(user.id),
          created_at: new Date(),
          updated_at: new Date(),
        });
      });
    } catch (e: any) {
      if (e.code === "23505")
        bad("A job of this kind is already queued or running.");
      throw e;
    }
    await audit(s.documentId, `queue:${kind}`, user);
    return id;
  };
  const admin = (
    method: string,
    path: string,
    handler: (ctx: any) => Promise<void>,
  ) => ({
    method,
    path: "/editorial" + path,
    handler: async (ctx: any) => {
      actor(ctx);
      if (
        ctx.method !== "GET" &&
        (!ctx.request.body ||
          typeof ctx.request.body !== "object" ||
          Array.isArray(ctx.request.body))
      )
        bad("Send a JSON object.");
      await handler(ctx);
    },
    config: { policies: ["admin::isAuthenticatedAdmin"] },
  });
  strapi.server.routes({
    type: "admin",
    routes: [
      admin("GET", "/ai/settings", async (ctx) => {
        requireKeyAdmin(ctx);
        ctx.body = {
          data: {
            managed: Boolean(
              (await db("ai_provider_settings").where({ id: 1 }).first())
                ?.managed,
            ),
            credentials: await db("ai_provider_credentials")
              .select(credentialColumns)
              .orderBy("priority")
              .orderBy("created_at"),
          },
        };
      }),
      admin("POST", "/ai/credentials", async (ctx) => {
        requireKeyAdmin(ctx);
        if (
          Number(
            (await db("ai_provider_credentials").count("* as n").first())?.n,
          ) >= 50
        )
          bad("Keep at most 50 credentials; remove unused keys first.");
        const { data, key } = credentialInput(ctx.request.body);
        const id = randomUUID(),
          now = new Date();
        const encrypted = encryptCredential(key, id, data.provider);
        await db.transaction(async (trx: any) => {
          await trx("ai_provider_credentials").insert({
            ...data,
            id,
            encrypted_key: encrypted,
            key_hint: "••••" + key.slice(-4),
            created_at: now,
            updated_at: now,
          });
          await trx("ai_provider_settings")
            .where({ id: 1 })
            .update({ managed: true });
          await trx("processing_jobs")
            .where({ state: "waiting" })
            .update({ next_run_at: now });
          await audit(id, "ai-credential:add", ctx.state.user, trx);
        });
        ctx.body = { data: { id } };
      }),
      admin("POST", "/ai/credentials/:id", async (ctx) => {
        requireKeyAdmin(ctx);
        const row = await db("ai_provider_credentials")
          .where({ id: ctx.params.id })
          .first();
        if (!row) ctx.throw(404);
        const { data, key } = credentialInput(ctx.request.body, row);
        const secret = key
          ? {
              encrypted_key: encryptCredential(key, row.id, row.provider),
              key_hint: "••••" + key.slice(-4),
              cooldown_until: null,
            }
          : {};
        await db.transaction(async (trx: any) => {
          await trx("ai_provider_credentials")
            .where({ id: row.id })
            .update({ ...data, ...secret, updated_at: new Date() });
          await trx("processing_jobs")
            .where({ state: "waiting" })
            .update({ next_run_at: new Date() });
          await audit(row.id, "ai-credential:update", ctx.state.user, trx);
        });
        ctx.body = { data: { ok: true } };
      }),
      admin("POST", "/ai/credentials/:id/delete", async (ctx) => {
        requireKeyAdmin(ctx);
        await db.transaction(async (trx: any) => {
          await trx("ai_provider_credentials")
            .where({ id: ctx.params.id })
            .delete();
          await audit(
            ctx.params.id,
            "ai-credential:delete",
            ctx.state.user,
            trx,
          );
        });
        ctx.body = { data: { ok: true } };
      }),
      admin("GET", "/config", async (ctx) => {
        ctx.body = {
          data: {
            maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 26214400),
          },
        };
      }),
      admin("GET", "/overview", async (ctx) => {
        const [
          articles,
          sources,
          jobs,
          events,
          publishedCount,
          draftCount,
          reviewCount,
          failedCount,
        ] = await Promise.all([
          strapi.documents(ARTICLE).findMany({
            status: "draft",
            sort: "updatedAt:desc",
            limit: 100,
          } as any),
          strapi
            .documents(SOURCE)
            .findMany({ sort: "createdAt:desc", limit: 100 } as any),
          db("processing_jobs")
            .select(
              "id",
              "source_id",
              "kind",
              "state",
              "attempts",
              "error",
              "result",
              "progress",
              "next_run_at",
              "article_id",
              "created_at",
              "updated_at",
            )
            .orderBy("created_at", "desc")
            .limit(100),
          db("editorial_audit_events")
            .orderBy("occurred_at", "desc")
            .limit(100),
          strapi.documents(ARTICLE).count({ status: "published" }),
          strapi.documents(ARTICLE).count({
            status: "draft",
            filters: { reviewStatus: "draft" },
          } as any),
          strapi.documents(ARTICLE).count({
            status: "draft",
            filters: { reviewStatus: "review" },
          } as any),
          db("processing_jobs")
            .where("state", "failed")
            .count("* as n")
            .first(),
        ]);
        ctx.body = {
          data: {
            articles,
            sources,
            jobs: jobs.map((row: any) => {
              const safe = decode(row);
              delete safe.checkpoint;
              return safe;
            }),
            events,
            counts: {
              published: publishedCount,
              draft: draftCount,
              review: reviewCount,
              failed: Number(failedCount?.n || 0),
            },
            canPublish: canApprove(ctx.state.user),
          },
        };
      }),
      admin("POST", "/documents", async (ctx) => {
        const b = ctx.request.body;
        if (b.pdfUrl) b.officialSourceUrl = String(b.pdfUrl);
        if (!isOfficialSource(b.officialSourceUrl))
          bad("Use an official Supreme Court HTTPS source URL.");
        let imported: any;
        if (b.pdfUrl) {
          imported = await importOfficialPdf(
            strapi,
            String(b.pdfUrl),
            ctx.state.user,
          );
          b.fileId = imported.id;
          b.officialSourceUrl = String(b.pdfUrl);
        }
        let s: any;
        try {
          s = await strapi.documents(SOURCE).create({
            data: {
              ...pick(b, [
                "title",
                "officialSourceUrl",
                "documentType",
                "caseTitle",
                "caseNumber",
                "diaryNumber",
                "judgmentDate",
                "bench",
                "editorialNotes",
              ]),
              originalPdf: b.fileId,
              uploadedBy: String(ctx.state.user.id),
            },
          } as any);
        } catch (error) {
          if (imported)
            await strapi.plugin("upload").service("upload").remove(imported);
          throw error;
        }
        await audit(s.documentId, "upload-source", ctx.state.user);
        const id = await enqueue(
          s,
          "extract",
          {
            autoGenerate:
              b.generateArticle === true && process.env.AI_ENABLED === "true",
          },
          ctx.state.user,
        );
        ctx.body = { data: { ...s, jobId: id } };
      }),
      admin("GET", "/documents/:id", async (ctx) => {
        const s = await source(ctx.params.id);
        if (!s) ctx.throw(404);
        ctx.body = {
          data: {
            ...(await present(s)),
            jobs: (
              await db("processing_jobs")
                .where("source_id", s.documentId)
                .orderBy("created_at", "desc")
                .limit(30)
            ).map((row: any) => {
              const safe = decode(row);
              delete safe.checkpoint;
              return safe;
            }),
          },
        };
      }),
      admin("POST", "/documents/:id/review", async (ctx) => {
        const s = await source(ctx.params.id);
        if (!s) ctx.throw(404);
        if (
          s.ocrRequired ||
          !s.extractedText ||
          s.processingStatus === "extracting"
        )
          bad(
            "Extraction must succeed and all pages must be readable before confirming.",
          );
        await strapi.documents(SOURCE).update({
          documentId: s.documentId,
          data: { textReviewed: true },
        } as any);
        await audit(s.documentId, "confirm-text-review", ctx.state.user);
        ctx.body = { data: { reviewed: true } };
      }),
      admin("POST", "/documents/:id/jobs", async (ctx) => {
        const s = await source(ctx.params.id);
        if (!s) ctx.throw(404);
        const b = ctx.request.body,
          payload: any = { force: b.force === true };
        if (b.kind === "revise") {
          const a = await article(b.articleId);
          if (!a || a.sourceDocument?.documentId !== s.documentId)
            bad("Select a draft linked to this source.");
          if (a.updatedAt !== b.expectedUpdatedAt)
            ctx.throw(
              409,
              "Draft changed; reload before requesting a revision.",
            );
          payload.articleId = a.documentId;
          payload.expectedUpdatedAt = a.updatedAt;
          payload.prior = pick(
            a,
            editable.filter(
              (k) =>
                ![
                  "editorialNotes",
                  "originalPdf",
                  "sourceDocument",
                  "author",
                  "slug",
                  "pdfUnavailableReason",
                ].includes(k),
            ),
          );
          payload.instruction = String(b.instruction || "").slice(0, 2000);
          if (!payload.instruction.trim()) bad("Enter a revision instruction.");
          const mode = String(b.mode || "full");
          const targets: Record<string, string> = {
            headline: "headline",
            summary: "summary",
            section: "articleBody",
            simpler: "articleBody",
            shorter: "articleBody",
            grammar: "articleBody",
          };
          if (mode !== "full" && !targets[mode])
            bad("Unknown revision action.");
          payload.targetField = targets[mode] || null;
          if (mode === "section") {
            const selected = String(b.selectedText || "");
            const start = a.articleBody.indexOf(selected);
            if (
              !selected.trim() ||
              selected.length > 5000 ||
              start < 0 ||
              start !== a.articleBody.lastIndexOf(selected)
            )
              bad(
                "Select a unique section of the saved article body (up to 5000 characters).",
              );
            payload.selectedText = selected;
            payload.instruction +=
              " Rewrite only this exact selected passage; retain all text before and after it verbatim: " +
              selected;
          }
          if (payload.targetField)
            payload.instruction +=
              " Change only " +
              payload.targetField +
              "; retain all other fields exactly.";
        }
        ctx.body = {
          data: { id: await enqueue(s, b.kind, payload, ctx.state.user) },
        };
      }),
      admin("POST", "/jobs/:id/retry", async (ctx) => {
        const job = decode(
          await db("processing_jobs").where({ id: ctx.params.id }).first(),
        );
        if (!job) ctx.throw(404);
        if (job.state !== "failed") bad("Only failed jobs can be retried.");
        const s = await source(job.source_id);
        ctx.body = {
          data: {
            id: await enqueue(
              s,
              job.kind,
              { ...job.payload, force: true },
              ctx.state.user,
              job.checkpoint,
            ),
          },
        };
      }),
      admin("POST", "/jobs/:id/apply", async (ctx) => {
        const job = decode(
          await db("processing_jobs").where({ id: ctx.params.id }).first(),
        );
        if (!job || job.state !== "succeeded" || !job.result?.draft)
          bad("This job has no validated draft proposal.");
        if (ctx.request.body.confirm !== true)
          bad("Explicit confirmation is required to apply a proposal.");
        const s = await source(job.source_id),
          d = job.result.draft;
        if (s.documentSha256 !== job.payload.checksum)
          bad("The source changed after generation. Generate a new proposal.");
        const data: any = {
          ...pick(
            d,
            job.payload.targetField ? [job.payload.targetField] : editable,
          ),
          documentType: d.documentType || "Other",
          sourceDocument: s.documentId,
          originalPdf: s.originalPdf?.id ?? null,
          officialSourceUrl: s.officialSourceUrl,
          sourceSearchText: s.extractedText,
          aiModel: job.result.usage?.model,
          promptVersion: job.result.promptVersion,
          uncertainties: d.uncertainties,
          verificationChecklist: d.verificationChecklist,
          accuracyWarnings: job.result.accuracyWarnings,
        };
        if (job.payload.articleId && job.payload.targetField)
          delete data.documentType;
        if (!d.headline || !d.summary || !d.articleBody)
          bad(
            "The proposal lacks required copy. Create or edit a manual draft instead.",
          );
        let a: any;
        await strapi.db.transaction(async ({ trx }) => {
          const locked = await trx("processing_jobs")
            .where({ id: job.id })
            .forUpdate()
            .first();
          if (locked.article_id)
            bad(
              "This proposal was already applied. Open its existing article.",
            );
          if (job.payload.articleId) {
            await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
              job.payload.articleId,
            ]);
            const old = await article(job.payload.articleId);
            if (old?.updatedAt !== job.payload.expectedUpdatedAt)
              ctx.throw(
                409,
                "The editor draft changed after this proposal was requested. It has not been overwritten.",
              );
            a = await strapi
              .documents(ARTICLE)
              .update({ documentId: old.documentId, data } as any);
          } else {
            data.slug =
              String(d.headline)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 120) +
              "-" +
              job.id.slice(0, 8);
            if (data.slug.startsWith("-"))
              data.slug = "court-report" + data.slug;
            data.category = "Other";
            data.author = String(
              ctx.request.body.author || ctx.state.user.firstname || "",
            ).trim();
            a = await strapi.documents(ARTICLE).create({ data } as any);
          }
          await trx("processing_jobs")
            .where({ id: job.id })
            .update({ article_id: a.documentId });
        });
        await audit(a.documentId, "apply-ai-proposal", ctx.state.user);
        ctx.body = { data: a };
      }),
      admin("POST", "/articles", async (ctx) => {
        ctx.body = {
          data: await strapi
            .documents(ARTICLE)
            .create({ data: pick(ctx.request.body, editable) } as any),
        };
      }),
      admin("GET", "/articles/:id", async (ctx) => {
        const a = await article(ctx.params.id);
        if (!a) ctx.throw(404);
        ctx.body = {
          data: {
            ...(await present(a)),
            publicationDate:
              (
                await strapi
                  .documents(ARTICLE)
                  .findOne({ documentId: a.documentId, status: "published" })
              )?.publishedAt || null,
            canPublish: canApprove(ctx.state.user),
            versions: (
              await db("article_versions")
                .where({ document_id: a.documentId })
                .orderBy("created_at", "desc")
                .limit(30)
            ).map((row: any) => {
              const safe = decode(row);
              delete safe.checkpoint;
              return safe;
            }),
          },
        };
      }),
      admin("PUT", "/articles/:id", async (ctx) => {
        await strapi.db.transaction(async ({ trx }) => {
          await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
            ctx.params.id,
          ]);
          await current(ctx);
          ctx.body = {
            data: await strapi.documents(ARTICLE).update({
              documentId: ctx.params.id,
              data: pick(ctx.request.body.data || {}, editable),
            } as any),
          };
        });
      }),
      admin("POST", "/articles/:id/action", async (ctx) => {
        await strapi.db.transaction(async ({ trx }) => {
          await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
            ctx.params.id,
          ]);
          const a = await current(ctx),
            action = ctx.request.body.action;
          if (
            ["approve", "publish", "unpublish", "restore"].includes(action) &&
            !canApprove(ctx.state.user)
          )
            throw new errors.ForbiddenError(
              "A publisher must perform this action.",
            );
          if (action === "submit" || action === "approve") {
            if (action === "approve")
              validatePublication({ ...a, reviewStatus: "approved" });
            ctx.body = {
              data: await strapi.documents(ARTICLE).update({
                documentId: a.documentId,
                data: {
                  reviewStatus: action === "approve" ? "approved" : "review",
                },
              } as any),
            };
          } else if (action === "publish" || action === "unpublish")
            ctx.body = {
              data: await (strapi.documents(ARTICLE) as any)[action]({
                documentId: a.documentId,
              }),
            };
          else if (action === "restore") {
            const v = decode(
              await trx("article_versions")
                .where({
                  id: ctx.request.body.versionId,
                  document_id: a.documentId,
                })
                .first(),
            );
            if (!v) ctx.throw(404);
            const restored = pick(v.snapshot, editable);
            if (
              restored.originalPdf &&
              !(await strapi.db
                .query("plugin::upload.file")
                .findOne({ where: { id: restored.originalPdf } }))
            )
              restored.originalPdf = null;
            ctx.body = {
              data: await strapi.documents(ARTICLE).update({
                documentId: a.documentId,
                data: restored,
              } as any),
            };
          } else bad("Unknown editorial action.");
        });
      }),
    ] as any,
  });
  const workerAuth = (ctx: any) => {
    const expected = process.env.PROCESSOR_TOKEN || "",
      actual = String(ctx.get("authorization") || "").replace(/^Bearer /, "");
    if (
      expected.length < 32 ||
      actual.length !== expected.length ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      ctx.throw(401);
    ctx.set("Cache-Control", "no-store");
  };
  const worker = (
    method: string,
    path: string,
    handler: (ctx: any) => Promise<void>,
  ) => ({
    method,
    path: "/worker" + path,
    handler: async (ctx: any) => {
      workerAuth(ctx);
      await handler(ctx);
    },
    config: { auth: false },
  });
  const validateCheckpoint = (checkpoint: any) => {
    if (
      !checkpoint ||
      checkpoint.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(checkpoint.fingerprint || "") ||
      !checkpoint.entries ||
      typeof checkpoint.entries !== "object" ||
      Array.isArray(checkpoint.entries) ||
      Buffer.byteLength(JSON.stringify(checkpoint)) > 8 * 1024 * 1024 ||
      Object.keys(checkpoint.entries).length > 5000
    )
      bad("Invalid or oversized generation checkpoint.");
  };
  const lease = async (ctx: any, trx: any = db) => {
    const j = await trx("processing_jobs")
      .where({
        id: ctx.params.id,
        state: "running",
        lease_token: ctx.request.body?.lease || ctx.query.lease,
      })
      .first();
    if (!j || new Date(j.lease_until).getTime() < Date.now())
      ctx.throw(
        409,
        "The job lease expired. This result cannot replace another attempt.",
      );
    return decode(j);
  };
  strapi.server.routes({
    type: "content-api",
    routes: [
      worker("POST", "/claim", async (ctx) => {
        let job: any = null;
        await db.transaction(async (trx: any) => {
          await trx("processing_jobs")
            .where("state", "running")
            .where("lease_until", "<", new Date())
            .where("lease_failures", ">=", 2)
            .update({
              state: "failed",
              error: "Worker lease expired after three attempts.",
              updated_at: new Date(),
            });
          job = await trx("processing_jobs")
            .where((q: any) =>
              q
                .where("state", "queued")
                .orWhere((q: any) =>
                  q
                    .where("state", "waiting")
                    .where("next_run_at", "<=", new Date()),
                )
                .orWhere((q: any) =>
                  q
                    .where("state", "running")
                    .where("lease_until", "<", new Date()),
                ),
            )
            .where("lease_failures", "<", 3)
            .orderBy("created_at")
            .forUpdate()
            .skipLocked()
            .first();
          if (!job) return;
          job = {
            ...job,
            lease_failures:
              Number(job.lease_failures || 0) +
              (job.state === "running" ? 1 : 0),
            state: "running",
            attempts: job.attempts + 1,
            lease_token: randomUUID(),
            lease_until: new Date(Date.now() + 300000),
            updated_at: new Date(),
          };
          await trx("processing_jobs")
            .where({ id: job.id })
            .update(
              pick(job, [
                "state",
                "lease_failures",
                "attempts",
                "lease_token",
                "lease_until",
                "updated_at",
              ]),
            );
        });
        if (job) {
          job = decode(job);
          const s = await source(job.source_id);
          if (!s) bad("Source document no longer exists.");
          await strapi.documents(SOURCE).update({
            documentId: s.documentId,
            data: {
              processingStatus:
                job.kind === "extract" ? "extracting" : "generating",
              processingError: null,
            },
          } as any);
          job = {
            ...job,
            ...(ctx.request.body?.protocol === 2
              ? { aiConfig: await workerCredentialConfig(db) }
              : {}),
            checksum: s.documentSha256,
            extraction: {
              text: s.extractedText,
              ocrRequired: s.ocrRequired,
              warnings: s.extractionMetadata?.warnings || [],
            },
            metadata: {
              ...pick(s, [
                "caseTitle",
                "caseNumber",
                "judgmentDate",
                "bench",
                "officialSourceUrl",
              ]),
              hasOriginalPdf: Boolean(s.originalPdf),
            },
          };
        }
        ctx.body = { data: job ?? null };
      }),
      worker("GET", "/config", async (ctx) => {
        ctx.body = { data: await workerCredentialConfig(db) };
      }),
      worker("POST", "/jobs/:id/checkpoint", async (ctx) => {
        await db.transaction(async (trx: any) => {
          await trx("processing_jobs")
            .where({ id: ctx.params.id })
            .forUpdate()
            .first();
          const j = await lease(ctx, trx),
            b = ctx.request.body;
          if (j.kind === "extract")
            bad("Extraction does not accept generation checkpoints.");
          validateCheckpoint(b.checkpoint);
          await trx("processing_jobs")
            .where({ id: j.id })
            .update({
              checkpoint: JSON.stringify(b.checkpoint),
              progress: JSON.stringify(b.checkpoint.progress || {}),
              updated_at: new Date(),
            });
        });
        ctx.body = { data: { ok: true } };
      }),
      worker("POST", "/jobs/:id/defer", async (ctx) => {
        await strapi.db.transaction(async ({ trx }) => {
          await trx("processing_jobs")
            .where({ id: ctx.params.id })
            .forUpdate()
            .first();
          const j = await lease(ctx, trx),
            b = ctx.request.body;
          validateCheckpoint(b.checkpoint);
          const seconds = Number(b.retryAfter);
          if (!Number.isFinite(seconds) || seconds < 1 || seconds > 2678400)
            bad("Invalid retry delay.");
          const next = new Date(Date.now() + Math.ceil(seconds) * 1000);
          for (const c of Array.isArray(b.cooldowns)
            ? b.cooldowns.slice(0, 50)
            : []) {
            const until = Number(c.until);
            if (
              typeof c.id === "string" &&
              Number.isFinite(until) &&
              until > Date.now() / 1000 &&
              until <= Date.now() / 1000 + 2678400
            )
              await trx("ai_provider_credentials")
                .where({ id: c.id })
                .update({ cooldown_until: new Date(until * 1000) });
          }
          const progress = {
            ...(b.checkpoint.progress || {}),
            waiting: true,
            waitingReason:
              b.reason === "no_credentials" ? "no_credentials" : "quota",
            nextRunAt: next.toISOString(),
          };
          await trx("processing_jobs")
            .where({ id: j.id })
            .update({
              state: "waiting",
              checkpoint: JSON.stringify(b.checkpoint),
              progress: JSON.stringify(progress),
              next_run_at: next,
              lease_token: null,
              lease_until: null,
              error: null,
              updated_at: new Date(),
            });
          await strapi.documents(SOURCE).update({
            documentId: j.source_id,
            data: { processingStatus: "waiting", processingError: null },
          } as any);
          await audit(j.source_id, "processing:waiting-for-quota", null, trx);
        });
        ctx.body = { data: { ok: true } };
      }),
      worker("POST", "/jobs/:id/heartbeat", async (ctx) => {
        await db.transaction(async (trx: any) => {
          await trx("processing_jobs")
            .where({ id: ctx.params.id })
            .forUpdate()
            .first();
          await lease(ctx, trx);
          await trx("processing_jobs")
            .where({ id: ctx.params.id })
            .update({ lease_until: new Date(Date.now() + 300000) });
        });
        ctx.body = { data: { ok: true } };
      }),
      worker("GET", "/jobs/:id/pdf", async (ctx) => {
        const j = await lease(ctx),
          s = await source(j.source_id),
          file = s?.originalPdf;
        if (!file || j.kind !== "extract") ctx.throw(404);
        ctx.type = "application/pdf";
        if (file.provider === "local") {
          if (
            !file.url.startsWith("/uploads/") ||
            basename(file.url) !== file.url.slice(9)
          )
            ctx.throw(404);
          ctx.body = createReadStream(
            resolve(strapi.dirs.static.public, "uploads", basename(file.url)),
          );
        } else {
          const signed = await strapi
            .plugin("upload")
            .provider.getSignedUrl(file);
          const response = await fetch(signed.url, {
            redirect: "error",
            signal: AbortSignal.timeout(60000),
          });
          if (!response.ok || !response.body) ctx.throw(502);
          ctx.body = Readable.fromWeb(response.body as any);
        }
      }),
      worker("POST", "/jobs/:id/complete", async (ctx) => {
        await strapi.db.transaction(async ({ trx }) => {
          await trx("processing_jobs")
            .where({ id: ctx.params.id })
            .forUpdate()
            .first();
          const j = await lease(ctx, trx),
            s = await source(j.source_id),
            b = ctx.request.body;
          if (s.documentSha256 !== j.payload.checksum)
            bad("The source changed while processing. Result rejected.");
          let result = b.result;
          if (!b.error) {
            if (j.kind === "extract") {
              if (
                result?.sha256 !== s.documentSha256 ||
                typeof result?.text !== "string" ||
                !Array.isArray(result?.pages) ||
                result.pageCount !== result.pages.length ||
                result.pageCount > 1000 ||
                result.text.length > 10000000
              )
                bad("Invalid extraction result.");
              await strapi.documents(SOURCE).update({
                documentId: s.documentId,
                data: {
                  extractedText: result.text,
                  pageCount: result.pageCount,
                  ocrRequired: Boolean(result.ocrRequired),
                  textReviewed: false,
                  extractionMetadata: result,
                  processingStatus: result.ocrRequired
                    ? "ocr_required"
                    : "ready_for_review",
                  processingError: null,
                },
              } as any);
            } else {
              const schema = JSON.parse(
                readFileSync(
                  resolve(
                    strapi.dirs.app.root,
                    "resources/article.schema.json",
                  ),
                  "utf8",
                ),
              );
              if (!new Ajv().validate(schema, result?.draft))
                bad("AI proposal failed the shared article schema.");
              if (j.payload.selectedText) {
                const before = j.payload.prior.articleBody,
                  at = before.indexOf(j.payload.selectedText),
                  prefix = before.slice(0, at),
                  suffix = before.slice(at + j.payload.selectedText.length),
                  body = result.draft.articleBody;
                if (
                  typeof body !== "string" ||
                  !body.startsWith(prefix) ||
                  !body.endsWith(suffix)
                )
                  bad(
                    "The proposal changed text outside the selected section. Request a new revision.",
                  );
              }
              if (
                !Array.isArray(result.accuracyWarnings) ||
                result.accuracyWarnings.some((x: any) => typeof x !== "string")
              )
                bad("Invalid accuracy warnings.");
              await strapi.documents(SOURCE).update({
                documentId: s.documentId,
                data: {
                  processingStatus: "ready_for_review",
                  aiModel: result.usage?.model,
                  promptVersion: result.promptVersion,
                  processingError: null,
                },
              } as any);
            }
          } else {
            result = b.usage ? { usage: b.usage } : null;
            await strapi.documents(SOURCE).update({
              documentId: s.documentId,
              data: {
                processingStatus: "failed",
                processingError: String(b.error).slice(0, 1500),
              },
            } as any);
          }
          await trx("processing_jobs")
            .where({ id: j.id })
            .update({
              state: b.error ? "failed" : "succeeded",
              result: result ? JSON.stringify(result) : null,
              error: b.error ? String(b.error).slice(0, 1500) : null,
              lease_until: null,
              updated_at: new Date(),
            });
          await audit(
            s.documentId,
            `${j.kind}:${b.error ? "failed" : "succeeded"}`,
            null,
            trx,
          );
          // Queue generation atomically with extraction completion so closing the browser cannot interrupt it.
          if (
            !b.error &&
            j.kind === "extract" &&
            j.payload.autoGenerate &&
            !result.ocrRequired &&
            result.text.trim()
          ) {
            await trx("processing_jobs").insert({
              id: randomUUID(),
              source_id: s.documentId,
              kind: "generate",
              state: "queued",
              payload: JSON.stringify({ checksum: s.documentSha256 }),
              requested_by: j.requested_by,
              created_at: new Date(),
              updated_at: new Date(),
            });
            await audit(s.documentId, "queue:generate-after-upload", null, trx);
          }
        });
        ctx.body = { data: { ok: true } };
      }),
    ] as any,
  });
}
