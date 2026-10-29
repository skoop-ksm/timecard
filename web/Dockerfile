FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY shared ./shared
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8787
USER node
HEALTHCHECK --interval=60s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/settings >/dev/null || exit 1
CMD ["node", "server.js"]
