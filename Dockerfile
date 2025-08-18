FROM node:20-alpine

# Set working dir
WORKDIR /app

# Copy root package.json and package-lock.json
COPY package*.json ./

# Install dependencies + pm2
RUN npm install --only=production && npm install -g pm2

# Copy backend code
COPY backend /app/backend

ENV NODE_ENV=production

# Default CMD (overridden by docker-compose for each service)
WORKDIR /app/backend
CMD ["pm2-runtime", "price-server/index.js"]
