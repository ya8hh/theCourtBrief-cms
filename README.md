# CMS and processing backend

Standalone Strapi 5 project. Requires Node 24 and PostgreSQL 16. This is a persistent backend, not a Vercel function.

```sh
npm ci
node scripts/init-env.mjs
# Edit .env: real database host/port/user/password and service URLs.
npm run migrate
npm run develop
```

`init-env.mjs` creates .env with independent random secrets only if it does not already exist. Configure `WEB_ORIGIN` with the public and editorial origins, comma separated. Create the first administrator privately at `/admin`, then assign editorial users Court Reporter/Court Publisher roles.

```sh
npm run lint
npm run typecheck
npm run build
npm start
```

## Host

Use this folder as build context for Dockerfile, or `npm ci && npm run build` as build command and `npm start` as start command. Set production environment variables from .env.example. Run `npm run migrate` before starting after updates. Use a persistent private volume mounted at `/app/public/uploads` with the included Dockerfile; never expose that directory through a static file server. Configure PostgreSQL backups and test restoration. No production data or credentials are bundled.

## PDF/AI worker — separate process/service

```sh
python3 -m venv processor/.venv
processor/.venv/bin/pip install -r processor/requirements.txt
processor/.venv/bin/python processor/worker.py
processor/.venv/bin/python -m pytest processor/tests -q
```

Local worker reads this project's .env. Set CMS_URL to the CMS address, PROCESSOR_TOKEN to the identical secret on CMS and worker, AI_ENABLED=true and your LLM_BASE_URL/LLM_MODEL/LLM_API_KEY for AI generation. OCR is optional; native OCR needs Tesseract. Do not commit the key.

For a separate hosted worker, use this repository root as build context and processor/Dockerfile. The worker needs no public port. Give it its own environment variables. PDFs are private until publication; cleanup then removes stored PDF bytes while retaining extracted text and official-source links.


## Saved progress and AI-provider management

See `DEPLOY-RESUMABLE-AI.md` for the coordinated CMS/editorial/worker upgrade. Super administrators can add multiple encrypted keys per provider at /editorial/settings. Long jobs save analysis and automatically resume after quota waits. The worker must be updated once before web-managed keys take effect.
