# Worker image — Node.js + k6 binary in the same container so the worker can
# spawn k6 directly. When we move to k8s, swap this for a Job-based runner.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends gnupg ca-certificates curl \
 && curl -fsSL https://dl.k6.io/key.gpg | gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" > /etc/apt/sources.list.d/k6.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends k6 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "run", "start"]
