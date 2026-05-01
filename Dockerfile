FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY bin/ ./bin/

ENTRYPOINT ["node", "bin/agent-marketplace-mcp.js"]
