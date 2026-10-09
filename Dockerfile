# Bash Arena: game client + multiplayer server in one image.
# The server serves the built client from ../dist, so one container = one URL.
#
#   docker build -t bash-arena .
#   docker run -p 3001:3001 -v bash-arena-data:/data bash-arena

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
WORKDIR /app/server
RUN npm ci && npm run build

FROM node:20-slim
ENV NODE_ENV=production PORT=3001 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json /app/server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
