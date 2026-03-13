/**
 * benchmark.cpp — pipelined latency + throughput benchmark
 * for flux-db's custom binary protocol.
 *
 * Usage:
 *   ./benchmark [num_requests] [pipeline_depth]
 *   ./benchmark 10000 16
 *
 * Default: 10000 requests, pipeline depth of 16.
 */

#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <netinet/ip.h>

#include <vector>
#include <string>
#include <algorithm>
#include <numeric>

// -------------------------------------------------------
// Protocol helpers (mirrors client.cpp)
// -------------------------------------------------------

static const size_t k_max_msg = 4096;

static int32_t read_full(int fd, char *buf, size_t n) {
    while (n > 0) {
        ssize_t rv = read(fd, buf, n);
        if (rv <= 0) return -1;
        n -= (size_t)rv;
        buf += rv;
    }
    return 0;
}

static int32_t write_all(int fd, const char *buf, size_t n) {
    while (n > 0) {
        ssize_t rv = write(fd, buf, n);
        if (rv <= 0) return -1;
        n -= (size_t)rv;
        buf += rv;
    }
    return 0;
}

// serialise a command into the binary protocol wire format
static std::vector<uint8_t> encode_cmd(const std::vector<std::string> &cmd) {
    uint32_t len = 4;   // 4 bytes for nargs
    for (const auto &s : cmd) {
        len += 4 + s.size();
    }

    std::vector<uint8_t> out;
    out.resize(4 + len);

    // 4-byte total length prefix
    memcpy(out.data(), &len, 4);
    // 4-byte argument count
    uint32_t n = (uint32_t)cmd.size();
    memcpy(out.data() + 4, &n, 4);

    size_t cur = 8;
    for (const auto &s : cmd) {
        uint32_t p = (uint32_t)s.size();
        memcpy(out.data() + cur, &p, 4);
        memcpy(out.data() + cur + 4, s.data(), s.size());
        cur += 4 + s.size();
    }
    return out;
}

// drain one response from the socket (we don't care about the value)
static int32_t drain_response(int fd) {
    char rbuf[4 + k_max_msg];
    // read 4-byte header
    if (read_full(fd, rbuf, 4) < 0) return -1;
    uint32_t len = 0;
    memcpy(&len, rbuf, 4);
    if (len > k_max_msg) return -1;
    // read body
    if (read_full(fd, rbuf + 4, len) < 0) return -1;
    return 0;
}

// -------------------------------------------------------
// Timing
// -------------------------------------------------------

static uint64_t now_us() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ULL + ts.tv_nsec / 1000ULL;
}

// -------------------------------------------------------
// Connection
// -------------------------------------------------------

static int make_connection() {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        exit(1);
    }
    struct sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = ntohs(1234);
    addr.sin_addr.s_addr = ntohl(INADDR_LOOPBACK);
    if (connect(fd, (const struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("connect — is the server running?");
        exit(1);
    }
    return fd;
}

// -------------------------------------------------------
// Histogram
// -------------------------------------------------------

struct Histogram {
    // buckets: <100us, <200us, <500us, <1ms, <2ms, <5ms, <10ms, <20ms, <50ms, >=50ms
    static const size_t N = 10;
    static const uint64_t bounds[N];
    uint64_t counts[N] = {};
    uint64_t total = 0;

    void record(uint64_t us) {
        total++;
        for (size_t i = 0; i < N; i++) {
            if (us < bounds[i]) {
                counts[i]++;
                return;
            }
        }
        counts[N - 1]++;
    }
};

const uint64_t Histogram::bounds[Histogram::N] = {
    100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, UINT64_MAX
};

static const char *bucket_label(size_t i) {
    static const char *labels[] = {
        "<100us", "<200us", "<500us", "<1ms", "<2ms",
        "<5ms",   "<10ms",  "<20ms",  "<50ms", ">=50ms"
    };
    return labels[i];
}

static void print_histogram(const Histogram &h) {
    printf("\n  Latency histogram:\n");
    for (size_t i = 0; i < Histogram::N; i++) {
        if (h.counts[i] == 0) continue;
        double pct = 100.0 * h.counts[i] / h.total;
        // draw a simple bar
        int bar = (int)(pct / 2);
        printf("  %8s | ", bucket_label(i));
        for (int j = 0; j < bar; j++) printf("#");
        printf(" %.2f%% (%lu)\n", pct, h.counts[i]);
    }
}

// -------------------------------------------------------
// Benchmark runner
// -------------------------------------------------------

struct BenchResult {
    double ops_per_sec;
    double avg_us;
    double p50_us;
    double p99_us;
    double p999_us;
    Histogram hist;
};

static BenchResult run_bench(
    const char *label,
    const std::vector<std::string> &cmd,
    int num_requests,
    int pipeline_depth)
{
    int fd = make_connection();

    // pre-encode the command once
    std::vector<uint8_t> encoded = encode_cmd(cmd);

    std::vector<uint64_t> latencies;
    latencies.reserve(num_requests);

    int sent = 0;
    int received = 0;

    uint64_t bench_start = now_us();

    while (received < num_requests) {
        // fill the pipeline
        int inflight = sent - received;
        while (inflight < pipeline_depth && sent < num_requests) {
            write_all(fd, (const char *)encoded.data(), encoded.size());
            sent++;
            inflight++;
        }

        // drain one response and record latency
        uint64_t t0 = now_us();
        if (drain_response(fd) < 0) {
            fprintf(stderr, "read error during benchmark\n");
            exit(1);
        }
        uint64_t t1 = now_us();
        latencies.push_back(t1 - t0);
        received++;
    }

    uint64_t bench_end = now_us();
    double elapsed_sec = (bench_end - bench_start) / 1e6;

    close(fd);

    // compute stats
    std::sort(latencies.begin(), latencies.end());
    double sum = std::accumulate(latencies.begin(), latencies.end(), 0ULL);

    BenchResult r;
    r.ops_per_sec  = num_requests / elapsed_sec;
    r.avg_us       = sum / latencies.size();
    r.p50_us       = latencies[latencies.size() * 50 / 100];
    r.p99_us       = latencies[latencies.size() * 99 / 100];
    r.p999_us      = latencies[latencies.size() * 999 / 1000];

    Histogram h;
    for (uint64_t v : latencies) h.record(v);
    r.hist = h;

    printf("\n============================\n");
    printf("  Benchmark: %s\n", label);
    printf("  Requests:  %d\n", num_requests);
    printf("  Pipeline:  %d\n", pipeline_depth);
    printf("============================\n");
    printf("  Throughput: %.0f ops/sec\n", r.ops_per_sec);
    printf("  Latency avg:  %.1f us\n",  r.avg_us);
    printf("  Latency p50:  %.1f us\n",  r.p50_us);
    printf("  Latency p99:  %.1f us\n",  r.p99_us);
    printf("  Latency p999: %.1f us\n",  r.p999_us);
    print_histogram(h);

    return r;
}

// -------------------------------------------------------
// main
// -------------------------------------------------------

int main(int argc, char **argv) {
    int num_requests  = (argc > 1) ? atoi(argv[1]) : 10000;
    int pipeline_depth = (argc > 2) ? atoi(argv[2]) : 16;

    if (num_requests <= 0 || pipeline_depth <= 0) {
        fprintf(stderr, "usage: %s [num_requests] [pipeline_depth]\n", argv[0]);
        return 1;
    }

    printf("flux-db benchmark\n");
    printf("requests=%d  pipeline=%d\n", num_requests, pipeline_depth);

    // SET benchmark — use rotating keys to avoid always hitting the same slot
    {
        std::vector<std::string> cmd = {"set", "bench:key:0001", "helloworld"};
        run_bench("SET", cmd, num_requests, pipeline_depth);
    }

    // GET benchmark
    {
        std::vector<std::string> cmd = {"get", "bench:key:0001"};
        run_bench("GET", cmd, num_requests, pipeline_depth);
    }

    // ZADD benchmark
    {
        std::vector<std::string> cmd = {"zadd", "bench:zset", "1.0", "member1"};
        run_bench("ZADD", cmd, num_requests, pipeline_depth);
    }

    // ZSCORE benchmark
    {
        std::vector<std::string> cmd = {"zscore", "bench:zset", "member1"};
        run_bench("ZSCORE", cmd, num_requests, pipeline_depth);
    }

    printf("\nDone.\n");
    return 0;
}
