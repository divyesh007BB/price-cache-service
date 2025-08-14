# Dockerfile — Price Server
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy rest of the app
COPY . .

# Expose the port (matches your .env / compose)
EXPOSE 4000

# Start the server
CMD ["npm", "start"]
