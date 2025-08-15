FROM node:20-alpine

# Set root working dir
WORKDIR /app

# Copy root package files
COPY package*.json ./

# Install dependencies once for all services
RUN npm install --only=production

# Copy backend code
COPY backend /app/backend

ENV NODE_ENV=production
