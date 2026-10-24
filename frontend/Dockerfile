FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
ENV NEXT_PUBLIC_SENTINEL_API_URL=http://localhost:8000
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_PUBLIC_SENTINEL_API_URL=http://localhost:8000 \
    PORT=3000

RUN addgroup --system --gid 10001 nodejs && \
    adduser --system --uid 10001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app ./

USER nextjs
EXPOSE 3000

CMD ["npm", "start"]
