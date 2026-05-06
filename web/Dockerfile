# Multi-stage build: produce static SPA assets, serve them with nginx.
# nginx also proxies /api/* to the API service so the SPA can use relative
# URLs and works behind any host without CORS dancing.

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# nginx's official image runs envsubst over /etc/nginx/templates/*.template
# at container start, substituting only ${VAR} (curly braces required) so
# that nginx's own $host, $uri, $remote_addr etc. are left alone.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Defaults — override via env (Helm chart sets API_UPSTREAM to the in-cluster
# API service; docker-compose sets it to http://api:4000).
ENV API_UPSTREAM=http://api:4000

EXPOSE 80
