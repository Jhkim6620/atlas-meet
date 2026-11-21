FROM node:24.22.3-bookworm-slim AS base
WORKDIR /opt/atlas-meet

FROM base AS speech
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates cmake curl \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/setup-speech.sh scripts/setup-speech.sh
RUN sh scripts/setup-speech.sh

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS server
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    ATLAS_DATA_DIR=/var/lib/atlas-meet/rooms
COPY --from=dependencies /opt/atlas-meet/node_modules ./node_modules
COPY --from=speech /opt/atlas-meet/.speech ./.speech
COPY package.json server.mjs transcribe.mjs ./
COPY public ./public
RUN mkdir -p /var/lib/atlas-meet/rooms \
    && chown -R node:node /var/lib/atlas-meet \
    && chmod 700 /var/lib/atlas-meet/rooms \
    && .speech/whisper-cli --help >/dev/null 2>&1
USER node
EXPOSE 4317
CMD ["node", "server.mjs"]
