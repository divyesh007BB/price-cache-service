FROM node:20-alpine

# Set working dir at project root
WORKDIR /app

# Copy root package.json and package-lock.json
COPY package*.json ./

# Install dependencies + pm2
RUN npm install --only=production && npm install -g pm2

# Copy backend code
COPY backend /app/backend

# Environment
ENV NODE_ENV=production

# Always run commands from /app (so node_modules resolve correctly)
WORKDIR /app

# Default CMD (can be overridden in docker-compose for each service)
CMD ["pm2-runtime", "backend/price-server/index.js"]
