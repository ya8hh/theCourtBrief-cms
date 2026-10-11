import { errors } from "@strapi/utils";
const UID = "api::case-article.case-article" as const;
const fields = [
  "headline",
  "slug",
  "subtitle",
  "summary",
  "articleBody",
  "documentType",
  "category",
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
  "author",
  "seoTitle",
  "seoDescription",
  "publishedAt",
  "updatedAt",
] as const;
function projection(row: any) {
  const value: any = { documentId: row.documentId };
  for (const key of fields) value[key] = row[key] ?? null;
  value.pdfUrl = value.officialSourceUrl;
  return value;
}
function pageNumber(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > max)
    throw new errors.ValidationError("Invalid pagination.");
  return Number(text);
}
export default {
  async health(ctx: any) {
    await strapi.db.connection.raw("select 1");
    ctx.body = { status: "ok" };
  },
  async list(ctx: any) {
    const page = pageNumber(ctx.query.page, 1, 10000),
      pageSize = pageNumber(ctx.query.pageSize, 9, 30);
    const allowed = [
      "page",
      "pageSize",
      "category",
      "documentType",
      "q",
      "publishedFrom",
      "publishedTo",
      "judgmentFrom",
      "judgmentTo",
      "judge",
      "topic",
    ];
    if (Object.keys(ctx.query).some((k) => !allowed.includes(k)))
      return ctx.badRequest("Unsupported query parameter.");
    const filters: any = {};
    if (ctx.query.category)
      filters.category = { $eq: String(ctx.query.category) };
    if (ctx.query.documentType)
      filters.documentType =
        String(ctx.query.documentType) === "Order"
          ? { $in: ["Daily Order", "Interim Order"] }
          : { $eq: String(ctx.query.documentType) };
    for (const [from, to, field] of [
      ["publishedFrom", "publishedTo", "publishedAt"],
      ["judgmentFrom", "judgmentTo", "judgmentDate"],
    ]) {
      for (const key of [from, to])
        if (
          ctx.query[key] &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(String(ctx.query[key])) ||
            Number.isNaN(Date.parse(String(ctx.query[key]))))
        )
          return ctx.badRequest("Use ISO dates in search filters.");
      if (ctx.query[from] || ctx.query[to])
        filters[field] = {
          ...(ctx.query[from] ? { $gte: ctx.query[from] } : {}),
          ...(ctx.query[to]
            ? {
                $lte:
                  field === "publishedAt"
                    ? ctx.query[to] + "T23:59:59.999Z"
                    : ctx.query[to],
              }
            : {}),
        };
    }
    for (const key of ["judge", "topic"]) {
      if (ctx.query[key]) {
        if (typeof ctx.query[key] !== "string" || ctx.query[key].length > 200)
          return ctx.badRequest("Filter is too long.");
        const column = key === "judge" ? "judges" : "legal_topics";
        const matches = await strapi.db.connection.raw(
          `SELECT document_id FROM case_articles WHERE published_at IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${column}::jsonb)='array' THEN ${column}::jsonb ELSE '[]'::jsonb END) AS term WHERE ${key === "topic" ? "regexp_replace(trim(both '-' from regexp_replace(lower(term),'[^a-z0-9]+','-','g')), '-+', '-', 'g')=regexp_replace(trim(both '-' from regexp_replace(lower(?),'[^a-z0-9]+','-','g')), '-+', '-', 'g')" : "lower(term)=lower(?)"})`,
          [ctx.query[key]],
        );
        const ids = matches.rows.map((r: any) => r.document_id);
        filters.$and = [...(filters.$and || []), { documentId: { $in: ids } }];
      }
    }
    if (ctx.query.q) {
      if (typeof ctx.query.q !== "string" || ctx.query.q.length > 200)
        return ctx.badRequest("Search must be at most 200 characters.");
      const result = await strapi.db.connection.raw(
        `SELECT document_id FROM case_articles WHERE published_at IS NOT NULL AND to_tsvector('english',coalesce(headline,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(case_title,'') || ' ' || coalesce(case_number,'') || ' ' || coalesce(bench,'') || ' ' || coalesce(judges::text,'') || ' ' || coalesce(legal_topics::text,'') || ' ' || coalesce(statutory_provisions::text,'') || ' ' || coalesce(source_search_text,'')) @@ plainto_tsquery('english', ?)`,
        [ctx.query.q],
      );
      filters.documentId = { $in: result.rows.map((r: any) => r.document_id) };
    }
    const [rows, total] = await Promise.all([
      strapi.documents(UID).findMany({
        status: "published",
        fields: [...fields],
        filters,
        sort: ["publishedAt:desc", "id:desc"],
        start: (page - 1) * pageSize,
        limit: pageSize,
        populate: { originalPdf: { fields: ["id"] } },
      } as any),
      strapi.documents(UID).count({ status: "published", filters }),
    ]);
    ctx.set("Cache-Control", "no-store");
    ctx.body = {
      data: rows.map(projection),
      meta: {
        pagination: {
          page,
          pageSize,
          total,
          pageCount: Math.ceil(total / pageSize),
        },
      },
    };
  },
  async detail(ctx: any) {
    const rows = await strapi.documents(UID).findMany({
      status: "published",
      filters: { slug: ctx.params.slug },
      fields: [...fields],
      populate: { originalPdf: { fields: ["id"] } },
      limit: 1,
    } as any);
    if (!rows[0]) return ctx.notFound("Article not found.");
    ctx.set("Cache-Control", "no-store");
    ctx.body = { data: projection(rows[0]) };
  },
  async pdf(ctx: any) {
    const rows: any[] = await strapi.documents(UID).findMany({
      status: "published",
      filters: { slug: ctx.params.slug },
      populate: ["originalPdf"],
      limit: 1,
    } as any);
    if (!rows[0]) return ctx.notFound("Article unavailable.");
    ctx.set("Cache-Control", "no-store");
    ctx.redirect(rows[0].officialSourceUrl);
  },
};
