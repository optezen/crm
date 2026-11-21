# Build from the repository root: docker build -f worker/Dockerfile .   (Node >= 22.18 is required to run the shared .ts adapters directly; 24 is used here)
FROM node:24-slim
WORKDIR /app
RUN npm install --no-save --omit=dev @supabase/supabase-js@^2.119.0
COPY worker ./worker
COPY src/lib/integrations ./src/lib/integrations
USER node
# one process type per image start command: override CMD with worker/integration-worker.mjs for the integrations worker
CMD ["node", "worker/automation-worker.mjs"]
