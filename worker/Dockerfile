# Build from the REPOSITORY ROOT:  docker build -f worker/Dockerfile .      Node >= 22.18 runs the shared .ts files directly; 24 is used here.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
RUN npm install --no-save --omit=dev @supabase/supabase-js@^2.119.0 && npm cache clean --force
COPY worker ./worker
COPY src/lib/integrations ./src/lib/integrations
COPY src/lib/workers ./src/lib/workers
COPY src/lib/env-guard.ts ./src/lib/env-guard.ts
USER node
EXPOSE 8080
# the start command is chosen per process group (see fly.worker.toml); this default runs the automation worker
CMD ["node", "worker/automation-worker.mjs"]
