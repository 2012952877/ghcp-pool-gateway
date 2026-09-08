FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY tsconfig.base.json ./
COPY src ./src
RUN npm ci \
  && npx playwright install --with-deps chromium \
  && npm --workspace @ghcp/shared run build \
  && npm --workspace @ghcp/login run build \
  && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 7003
CMD ["npm", "--workspace", "@ghcp/login", "run", "start:prod"]
