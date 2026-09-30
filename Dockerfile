# Контейнер ядра: тот же образ проверяется в CI и уходит в Yandex Serverless Containers.
ARG BASE_IMAGE=node:22-slim
FROM ${BASE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Корневой сертификат Yandex Managed PostgreSQL: без него ядро к базе не подключается (Б-13).
# Локально без доступа к storage.yandexcloud.net: --build-arg WITH_YC_CA=0.
ARG WITH_YC_CA=1
RUN mkdir -p /app/certs && if [ "$WITH_YC_CA" = "1" ]; then \
      node -e "fetch('https://storage.yandexcloud.net/cloud-certs/CA.pem').then(r=>{if(!r.ok)throw new Error('CA '+r.status);return r.text()}).then(t=>require('fs').writeFileSync('/app/certs/yandex-ca.pem',t))"; \
    fi
ENV DB_CA_PATH=/app/certs/yandex-ca.pem

COPY src ./src
COPY migrations ./migrations
COPY public ./public

# Не от root (Б-20).
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
