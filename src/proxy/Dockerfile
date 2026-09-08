FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY tsconfig.base.json ./
COPY src ./src
RUN npm ci \
  && npm --workspace @ghcp/shared run build \
  && npm --workspace @ghcp/proxy run build \
  && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "--workspace", "@ghcp/proxy", "run", "start:prod"]
