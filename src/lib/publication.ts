import { errors } from "@strapi/utils";
export function isOfficialSource(value: unknown): boolean {
  try {
    const u = new URL(String(value));
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      (u.hostname === "sci.gov.in" ||
        u.hostname.endsWith(".sci.gov.in") ||
        u.hostname === "supremecourtofindia.nic.in" ||
        u.hostname.endsWith(".supremecourtofindia.nic.in"))
    );
  } catch {
    return false;
  }
}
export function validatePublication(article: any) {
  for (const key of ["headline", "slug", "summary", "articleBody", "author"])
    if (typeof article[key] !== "string" || !article[key].trim())
      throw new errors.ValidationError(`${key} is required for publication.`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug))
    throw new errors.ValidationError("Use a lowercase, hyphenated slug.");
  for (const key of [
    "judges",
    "legalIssues",
    "legalTopics",
    "statutoryProvisions",
    "keyHoldings",
    "importantParagraphReferences",
  ])
    if (
      article[key] != null &&
      (!Array.isArray(article[key]) ||
        article[key].some((v: unknown) => typeof v !== "string"))
    )
      throw new errors.ValidationError(
        `${key} must be a JSON array of strings.`,
      );
  if (article.reviewStatus !== "approved")
    throw new errors.ValidationError(
      "An authorized publisher must approve this draft first.",
    );
  if (!isOfficialSource(article.officialSourceUrl))
    throw new errors.ValidationError(
      "Use an HTTPS official Supreme Court source URL.",
    );
  if (
    !article.originalPdf &&
    !article.pdfRetiredAt &&
    !new URL(article.officialSourceUrl).pathname
      .toLowerCase()
      .endsWith(".pdf") &&
    !(article.pdfUnavailableReason?.trim().length >= 20)
  )
    throw new errors.ValidationError(
      "Attach the original PDF or document an exception of at least 20 characters.",
    );
  if (article.originalPdf && article.originalPdf.mime !== "application/pdf")
    throw new errors.ValidationError("The original document must be a PDF.");
}
export function canApprove(user: any): boolean {
  return Boolean(
    user?.roles?.some((role: any) =>
      ["strapi-super-admin", "court-publisher"].includes(role.code),
    ),
  );
}
