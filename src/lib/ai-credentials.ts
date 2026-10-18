import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { errors } from "@strapi/utils";
export const providers = {
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
} as const;
export function encryptionKey() {
  const value = process.env.ENCRYPTION_KEY || "";
  if (value.length < 32)
    throw new errors.ApplicationError(
      "Configure a stable ENCRYPTION_KEY of at least 32 characters on the CMS before managing AI keys.",
    );
  return createHash("sha256").update(value).digest();
}
export function encryptCredential(
  secret: string,
  id: string,
  provider: string,
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(`${id}:${provider}`));
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [nonce, cipher.getAuthTag(), encrypted]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function decryptCredential(row: any) {
  try {
    const [nonce, tag, encrypted] = row.encrypted_key
      .split(".")
      .map((v: string) => Buffer.from(v, "base64"));
    const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
    cipher.setAAD(Buffer.from(`${row.id}:${row.provider}`));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new errors.ApplicationError(
      "AI credentials could not be decrypted. Check the CMS encryption configuration; keys were not disclosed.",
    );
  }
}
export const credentialColumns = [
  "id",
  "provider",
  "label",
  "model",
  "key_hint",
  "enabled",
  "priority",
  "input_price",
  "output_price",
  "cooldown_until",
  "updated_at",
];
export function credentialInput(body: any, existing?: any) {
  const provider = body.provider ?? existing?.provider;
  if (!Object.prototype.hasOwnProperty.call(providers, provider))
    throw new errors.ValidationError("Choose Groq, Gemini or OpenRouter.");
  if (existing && provider !== existing.provider)
    throw new errors.ValidationError(
      "Create a new credential to change provider.",
    );
  const model = String(body.model ?? existing?.model ?? "").trim();
  const label = String(body.label ?? existing?.label ?? "").trim();
  if (!label || label.length > 80 || !/^[a-zA-Z0-9_./:-]{1,150}$/.test(model))
    throw new errors.ValidationError(
      "Supply a label (up to 80 characters) and a valid model identifier.",
    );
  if (
    provider === "openrouter" &&
    model !== "openrouter/free" &&
    !model.endsWith(":free")
  )
    throw new errors.ValidationError(
      "OpenRouter is restricted to openrouter/free or an explicit :free model.",
    );
  const priority = Number(body.priority ?? existing?.priority ?? 10);
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000)
    throw new errors.ValidationError(
      "Priority must be between 0 and 1000; smaller numbers run first.",
    );
  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    throw new errors.ValidationError("Enabled must be true or false.");
  const price = (key: string) => {
    const raw = body[key] !== undefined ? body[key] : existing?.[key];
    if (provider === "openrouter") return 0;
    if (raw === undefined || raw === null || raw === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100000)
      throw new errors.ValidationError(
        "Prices must be nonnegative amounts per million tokens, or blank if unknown.",
      );
    return value;
  };
  const key = String(body.apiKey ?? "").trim();
  const existingSecret = existing ? decryptCredential(existing) : "";
  if (
    existingSecret &&
    (model.includes(existingSecret) || label.includes(existingSecret))
  )
    throw new errors.ValidationError(
      "Do not include API keys in labels or model identifiers.",
    );
  if ((!existing || key) && !/^[\x21-\x7e]{10,512}$/.test(key))
    throw new errors.ValidationError(
      "Enter a valid API key without spaces or newlines.",
    );
  // Never permit a credential to be reflected through its editable metadata.
  if (key && (model.includes(key) || label.includes(key)))
    throw new errors.ValidationError(
      "Do not include the API key in the label or model.",
    );
  return {
    data: {
      provider,
      model,
      label,
      priority,
      enabled: body.enabled ?? existing?.enabled ?? true,
      input_price: price("input_price"),
      output_price: price("output_price"),
    },
    key,
  };
}
export async function workerCredentialConfig(db: any) {
  const settings = await db("ai_provider_settings").where({ id: 1 }).first();
  if (!settings?.managed) return { managed: false, credentials: [] };
  const rows = await db("ai_provider_credentials")
    .where({ enabled: true })
    .orderBy("priority")
    .orderBy("created_at");
  return {
    managed: true,
    credentials: rows.map((row: any) => ({
      id: row.id,
      provider: row.provider,
      model: row.model,
      apiKey: decryptCredential(row),
      baseUrl: providers[row.provider as keyof typeof providers],
      inputPrice: row.input_price,
      outputPrice: row.output_price,
      cooldownUntil: row.cooldown_until
        ? new Date(row.cooldown_until).getTime() / 1000
        : null,
    })),
  };
}
