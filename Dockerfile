FROM node:20-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
COPY server.js ./
COPY public ./public
COPY defaults ./defaults
ENV PORT=8787 DATA_DIR=/data TZ=Europe/London
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/api/db/rev || exit 1
CMD ["node", "server.js"]
