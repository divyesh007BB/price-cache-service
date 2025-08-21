FROM node:20-alpine

# Set working dir
WORKDIR /app

# Copy package.json + lock
COPY package*.json ./

# Install deps + pm2
RUN npm install --only=production && npm install -g pm2

# Copy ALL backend source
COPY backend/price-server ./backend/price-server
COPY backend/matching-engine ./backend/matching-engine
COPY backend/shared ./backend/shared   # ✅ FIXED PATH

# Environment
ENV NODE_ENV=production

# Default CMD (overridden in docker-compose)
CMD ["pm2-runtime", "backend/price-server/index.js"]
