FROM node:20-alpine

# Set working dir
WORKDIR /app

# Copy package.json + lock
COPY package*.json ./

# Install deps + pm2
RUN npm install --only=production && npm install -g pm2

# Copy backend source
COPY backend/price-server ./backend/price-server
COPY backend/matching-engine ./backend/matching-engine
COPY backend/shared ./backend/shared

# 👇 Copy relay.js from project root into container
COPY relay.js ./relay.js

# Environment
ENV NODE_ENV=production

# Default CMD (overridden by docker-compose)
CMD ["pm2-runtime", "backend/price-server/index.js"]
