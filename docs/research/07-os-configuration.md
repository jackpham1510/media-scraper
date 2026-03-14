# 07 — OS Configuration & Process Launch

## File Descriptor Limit (Critical)

Every open TCP socket consumes one file descriptor (FD). Linux's default per-process FD limit is **1024**. With 5000 concurrent connections you will immediately exhaust this and get `EMFILE: too many open files` errors.

### Check current limits

```bash
ulimit -n           # soft limit (current session)
ulimit -Hn          # hard limit
cat /proc/sys/fs/file-max   # system-wide maximum
```

### Raise for current session

```bash
ulimit -n 65536
```

### Raise permanently (system-wide)

```bash
# /etc/security/limits.conf
*    soft    nofile    65536
*    hard    nofile    65536
root soft    nofile    65536
root hard    nofile    65536
```

```bash
# /etc/sysctl.conf (system-wide file descriptor pool)
fs.file-max = 1000000
```

### For systemd services

```ini
# /etc/systemd/system/scraper.service
[Service]
LimitNOFILE=65536
ExecStart=/usr/bin/node --max-old-space-size=700 /app/scraper.js
```

---

## Kernel TCP Settings

Optimize the kernel's TCP stack for many short-lived connections:

```bash
# /etc/sysctl.conf — apply with: sysctl -p

# Reuse TIME_WAIT sockets for new connections (reduces port exhaustion)
net.ipv4.tcp_tw_reuse = 1

# Larger connection backlog
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# Faster TIME_WAIT cleanup (60s → 30s)
net.ipv4.tcp_fin_timeout = 30

# Larger socket send/receive buffers
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# Increase local port range (for outbound connections)
net.ipv4.ip_local_port_range = 1024 65535
```

Apply immediately (no reboot):
```bash
sudo sysctl -p
```

---

## Node.js Launch Flags

### Recommended launch command

```bash
node \
  --max-old-space-size=700 \
  --max-semi-space-size=64 \
  scraper.js
```

### Full reference

| Flag | Value | Purpose |
|------|-------|---------|
| `--max-old-space-size` | `700` | V8 heap ceiling in MB. Prevents OOM-kill. |
| `--max-semi-space-size` | `64` | Young generation nursery size. Reduces premature promotion to Old Space. |
| `--gc-interval` | `100` | Force minor GC every N KB allocated. Keeps heap tidy. |
| `--dns-result-order` | `ipv4first` | Prefer IPv4 DNS resolution. Avoids delays on dual-stack hosts. |

### With environment variables

```bash
# Set before launching
export UV_THREADPOOL_SIZE=16   # libuv thread pool (default: 4)
                               # DNS resolution uses this pool
                               # Increase if many unique domains (DNS lookups)

node --max-old-space-size=700 --max-semi-space-size=64 scraper.js
```

> **`UV_THREADPOOL_SIZE`:** Each DNS lookup for a new hostname goes through libuv's thread pool. With 5000 URLs across many domains, the default pool of 4 threads can become a DNS bottleneck. Set to 16–32.

---

## DNS Caching

By default Node.js does not cache DNS resolutions. Each new request to a domain triggers a DNS lookup through the OS resolver. With thousands of unique domains this adds latency.

### Option A: `dnscache` package (simple)

```bash
npm install dnscache
```

```js
import dnscache from 'dnscache';

dnscache({
  enable: true,
  ttl: 300,      // cache DNS results for 5 minutes
  cachesize: 1000,
});

// Must be imported BEFORE undici/got/any HTTP client
```

### Option B: undici with custom DNS resolver

```js
import { Agent } from 'undici';
import { Resolver } from 'dns/promises';

const resolver = new Resolver();
const dnsCache = new Map();

const agent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      if (dnsCache.has(hostname)) {
        const cached = dnsCache.get(hostname);
        if (Date.now() < cached.expiry) {
          return callback(null, cached.address, cached.family);
        }
      }
      resolver.resolve4(hostname).then(addresses => {
        const address = addresses[0];
        dnsCache.set(hostname, {
          address,
          family: 4,
          expiry: Date.now() + 300_000, // 5 min TTL
        });
        callback(null, address, 4);
      }).catch(callback);
    },
  },
});
```

---

## Docker / Container Settings

If running in a container, override limits at the container level:

```dockerfile
# Dockerfile
FROM node:22-alpine

# Set ulimit inside container (if running as root)
RUN echo "* soft nofile 65536" >> /etc/security/limits.conf
RUN echo "* hard nofile 65536" >> /etc/security/limits.conf

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

CMD ["node", "--max-old-space-size=700", "--max-semi-space-size=64", "scraper.js"]
```

```bash
# docker run with limits
docker run \
  --ulimit nofile=65536:65536 \
  --memory=900m \              # container RAM limit
  --cpus=1 \                   # confirm single CPU
  my-scraper
```

```yaml
# docker-compose.yml
services:
  scraper:
    image: my-scraper
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
    mem_limit: 900m
    cpus: 1
    command: ["node", "--max-old-space-size=700", "--max-semi-space-size=64", "scraper.js"]
```
