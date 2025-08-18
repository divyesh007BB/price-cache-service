FROM node:20-alpine

# Set working dir
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies + PM2
RUN npm install --only=production && npm install -g pm2

# Copy backend code
COPY backend /app/backend

ENV NODE_ENV=production

# Default CMD (overridden by docker-compose)
CMD ["pm2-runtime", "index.js"]
