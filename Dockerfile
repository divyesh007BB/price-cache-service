FROM node:20-alpine

# Set working dir
WORKDIR /app

# Copy backend package files only
COPY backend/price-server/package*.json ./backend/price-server/
COPY shared/package*.json ./shared/

# Install deps
RUN cd backend/price-server && npm install --production && cd ../..
RUN npm install -g pm2

# Copy source
COPY backend/price-server ./backend/price-server
COPY shared ./shared

# Environment
ENV NODE_ENV=production
ENV PORT=4000

# Expose port
EXPOSE 4000

# Start with pm2
CMD ["pm2-runtime", "backend/price-server/index.js"]
