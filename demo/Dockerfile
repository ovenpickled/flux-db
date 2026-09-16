FROM debian:bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends g++ make && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN make clean && make server

FROM node:20-bookworm-slim

RUN useradd --create-home --shell /usr/sbin/nologin fluxdb

WORKDIR /app
COPY --from=builder /src/server ./bin/server

COPY demo/proxy/package.json ./proxy/package.json
RUN cd proxy && npm install --omit=dev --no-audit --no-fund

COPY demo/proxy/server.js ./proxy/server.js
COPY demo/public ./public

RUN mkdir -p /app/data && chown -R fluxdb:fluxdb /app

USER fluxdb
ENV DATA_DIR=/app/data
ENV SERVER_BIN=/app/bin/server

ENV PORT=8080
EXPOSE 8080

CMD ["node", "proxy/server.js"]