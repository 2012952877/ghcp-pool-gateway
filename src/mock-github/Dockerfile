FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY tsconfig.base.json ./
COPY src ./src
RUN npm install && npm --workspace @ghcp/shared run build
CMD ["npm", "--workspace", "@ghcp/mock-github", "run", "start"]
