FROM node:20-alpine

# Set working dir
WORKDIR /app

# Copy package.json + lock
COPY package*.json ./

# Install deps + pm2
RUN npm install --only=production && npm install -g pm2

# Copy ALL project files (backend + root scripts)
COPY . .

# Environment
ENV NODE_ENV=production

# Default CMD (overridden in docker-compose)
CMD ["pm2-runtime", "backend/price-server/index.js"]
