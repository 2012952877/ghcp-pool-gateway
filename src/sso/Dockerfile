FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY tsconfig.base.json ./
COPY src ./src
RUN npm ci \
  && npm --workspace @ghcp/shared run build \
  && npm --workspace @ghcp/sso run build \
  && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 7001
CMD ["npm", "--workspace", "@ghcp/sso", "run", "start:prod"]
