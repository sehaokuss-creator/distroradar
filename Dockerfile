# Production Dockerfile for DISTRIBUTORFINDER.XYZ
FROM node:20-slim

# Install latest Chromium and required fonts/libraries for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy package manifests first for caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Expose web server port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
