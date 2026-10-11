export default {
  routes: [
    {
      method: "GET",
      path: "/public/articles",
      handler: "public.list",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/public/articles/:slug/pdf",
      handler: "public.pdf",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/public/articles/:slug",
      handler: "public.detail",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/health",
      handler: "public.health",
      config: { auth: false },
    },
  ],
};
