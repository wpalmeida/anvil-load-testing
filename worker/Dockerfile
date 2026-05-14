# Worker image — Node.js + k6 binary in the same container so the worker can
# spawn k6 directly. When we move to k8s, swap this for a Job-based runner.
#
# Two-stage build because k6's apt repo only ships amd64. We download the
# right binary from k6's GitHub releases (which ship arm64 tarballs) using
# the TARGETARCH that buildx provides per platform.

ARG K6_VERSION=0.55.0

FROM debian:bookworm-slim AS k6-bin
ARG TARGETARCH
ARG K6_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-${TARGETARCH}.tar.gz" -o /tmp/k6.tar.gz \
 && tar -xzf /tmp/k6.tar.gz -C /tmp \
 && mv "/tmp/k6-v${K6_VERSION}-linux-${TARGETARCH}/k6" /usr/local/bin/k6 \
 && chmod +x /usr/local/bin/k6

FROM node:20-bookworm-slim
COPY --from=k6-bin /usr/local/bin/k6 /usr/local/bin/k6

# Chromium for k6's browser module. Adds ~300MB to the image; required only
# for "browser" test type runs. HTTP-only runs ignore it. If image size is
# a concern, fork the Dockerfile and drop these lines.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      libnss3 \
      ca-certificates \
      dbus \
 && rm -rf /var/lib/apt/lists/*
ENV K6_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
# --no-sandbox: Chromium refuses to start as root without it; in a
#               container we're root by default. Safe since the worker
#               is the only thing running here.
# --disable-dev-shm-usage: containers default /dev/shm to 64MB; Chromium
#               OOMs without this. Forces it to use /tmp instead.
ENV K6_BROWSER_ARGS=no-sandbox,disable-dev-shm-usage

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "run", "start"]
