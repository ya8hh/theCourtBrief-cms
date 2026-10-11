FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0 STRAPI_TELEMETRY_DISABLED=true
RUN npm run build
RUN mkdir -p public/uploads .local && chown -R node:node /app
USER node
EXPOSE 1337
CMD ["npm","start"]
