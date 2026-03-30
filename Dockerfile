# Playwright tabanlı imaj: Chromium ve sistem bağımlılıkları hazır (Hepsiburada / MediaMarkt / Çiçeksepeti).
# Cloud Run: PORT ortam değişkeni (varsayılan 8080).
FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

COPY package.json package-lock.json ./
COPY server ./server
COPY shared ./shared
COPY client/package.json ./client/package.json

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# DevDependencies (TypeScript) gerekli derleme için; derlemeden sonra üretim bağımlılıklarına indir.
# postinstall (playwright install) atlanır; taban imajdaki Chromium kullanılır (PLAYWRIGHT_BROWSERS_PATH).
RUN npm ci -w tr-price-compare-server --ignore-scripts
RUN npm run build -w tr-price-compare-server
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/dist/server/src/index.js"]
