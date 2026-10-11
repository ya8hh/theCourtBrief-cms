export default [
  "strapi::logger",
  "global::request-id",
  "strapi::errors",
  {
    name: "strapi::security",
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "connect-src": ["'self'", "https:"],
          "img-src": ["'self'", "data:", "blob:"],
          "media-src": ["'self'", "data:", "blob:"],
        },
      },
    },
  },
  {
    name: "strapi::cors",
    config: {
      origin: (process.env.WEB_ORIGIN || "http://localhost:3000").split(","),
      credentials: true,
    },
  },
  "strapi::poweredBy",
  "strapi::query",
  {
    name: "strapi::body",
    config: {
      formLimit: "1mb",
      jsonLimit: "32mb",
      formidable: {
        maxFileSize: Number(process.env.MAX_UPLOAD_BYTES || 26214400),
      },
    },
  },
  "strapi::session",
  "strapi::favicon",
  "global::pdf-uploads",
  "global::private-media",
  "strapi::public",
];
