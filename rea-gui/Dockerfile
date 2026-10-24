# REA GUI on a server. Build: docker build -t rea-gui .
# Run:   docker run -p 4517:4517 -e REA_GUI_PASSWORD=change-me -v rea-gui-data:/data rea-gui
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    REA_GUI_HOST=0.0.0.0 \
    PORT=4517 \
    REA_GUI_DATA_DIR=/data

# procps: REA checks child-process ownership with ps before launching helpers.
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY lib ./lib
COPY public ./public

# Saved analyses and uploads live in /data; mount a volume to keep them across upgrades.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 4517
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4517)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "bin/rea-gui.mjs", "--no-open"]
