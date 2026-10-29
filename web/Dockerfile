FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

COPY package.json server.js ./
COPY lib ./lib
COPY shared ./shared
COPY public ./public

# build id baked in by CI
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

# the data file lives on a mounted volume owned by uid 1000 (node)
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8787/api/settings >/dev/null || exit 1

CMD ["node", "server.js"]
