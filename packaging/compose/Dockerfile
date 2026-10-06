FROM node:22-alpine
WORKDIR /app
COPY server/.output ./.output
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 PACKAGEFLOW_DOCKER=1 PACKAGEFLOW_DATA_DIR=/app/.data
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
