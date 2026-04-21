FROM debian:bookworm-slim AS builder
RUN apt-get update && apt-get install -y g++ make
WORKDIR /app
COPY . .
RUN make clean && make server client

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=builder /app/server .
COPY --from=builder /app/client .
RUN mkdir -p /data
EXPOSE 1234
CMD ["./server"]
