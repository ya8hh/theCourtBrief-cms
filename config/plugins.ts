export default ({ env }: any) => ({
  ...(env("SMTP_HOST")
    ? {
        email: {
          config: {
            provider: "nodemailer",
            providerOptions: {
              host: env("SMTP_HOST"),
              port: env.int("SMTP_PORT", 587),
              secure: env.bool("SMTP_SECURE", false),
              auth: { user: env("SMTP_USERNAME"), pass: env("SMTP_PASSWORD") },
            },
            settings: {
              defaultFrom: env("SMTP_FROM"),
              defaultReplyTo: env("SMTP_REPLY_TO", env("SMTP_FROM")),
            },
          },
        },
      }
    : {}),
  upload: {
    config: {
      sizeLimit: env.int("MAX_UPLOAD_BYTES", 26214400),
      ...(env("UPLOAD_PROVIDER", "local") === "aws-s3"
        ? {
            provider: "aws-s3",
            providerOptions: {
              s3Options: {
                region: env("S3_REGION"),
                endpoint: env("S3_ENDPOINT"),
                forcePathStyle: env.bool("S3_FORCE_PATH_STYLE", false),
                credentials: {
                  accessKeyId: env("S3_ACCESS_KEY_ID"),
                  secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
                },
                params: {
                  Bucket: env("S3_BUCKET"),
                  ACL: "private",
                  signedUrlExpires: 300,
                },
              },
            },
          }
        : {}),
    },
  },
});
