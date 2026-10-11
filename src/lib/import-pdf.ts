import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { errors } from "@strapi/utils";
import { isOfficialSource } from "./publication";
export async function importOfficialPdf(
  strapi: any,
  url: string,
  user: any,
  fetcher: typeof fetch = fetch,
) {
  const max = Number(process.env.MAX_UPLOAD_BYTES || 26214400);
  const signal = AbortSignal.timeout(60000);
  let target = url,
    response: Response | undefined;
  for (let hop = 0; hop < 4; hop++) {
    if (!isOfficialSource(target))
      throw new errors.ValidationError(
        "Use a direct HTTPS PDF link on the official Supreme Court website.",
      );
    response = await fetcher(target, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location)
        throw new errors.ValidationError(
          "The court link returned an invalid redirect.",
        );
      target = new URL(location, target).href;
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body)
    throw new errors.ValidationError(
      "The court PDF could not be downloaded. Check the direct link or upload the file.",
    );
  if (Number(response.headers.get("content-length")) > max) {
    await response.body.cancel();
    throw new errors.ValidationError(
      "The linked PDF exceeds the upload size limit.",
    );
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new errors.ValidationError(
        "The linked PDF exceeds the upload size limit.",
      );
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new errors.ValidationError(
      "The link did not return a PDF. Paste the direct PDF download URL.",
    );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const duplicate = await strapi.db
    .query("api::source-document.source-document")
    .findOne({ where: { documentSha256: sha256 } });
  if (duplicate)
    throw new errors.ValidationError(
      `Duplicate source document: open existing record ${duplicate.documentId}.`,
    );
  const dir = await mkdtemp(join(tmpdir(), "court-pdf-"));
  try {
    const filepath = join(dir, "source.pdf");
    await writeFile(filepath, bytes);
    const name = decodeURIComponent(
      new URL(target).pathname.split("/").pop() || "court-order.pdf",
    )
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 200);
    const [file] = await strapi
      .plugin("upload")
      .service("upload")
      .upload(
        {
          data: {},
          files: {
            filepath,
            originalFilename: name,
            mimetype: "application/pdf",
            size,
          },
        },
        { user },
      );
    await strapi.db
      .query("plugin::upload.file")
      .update({
        where: { id: file.id },
        data: { provider_metadata: { ...file.provider_metadata, sha256 } },
      });
    return file;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
