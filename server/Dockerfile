FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./

RUN mkdir -p /updates && chown node:node /updates

ENV NODE_ENV=production \
    PORT=3000 \
    UPDATES_DIR=/updates

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
