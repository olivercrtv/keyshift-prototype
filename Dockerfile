# Base image with Debian (non-slim) for more reliable apt packages
FROM node:22-bookworm

# Install ffmpeg + Python + pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip
RUN pip3 install --no-cache-dir yt-dlp

# Create app directory
WORKDIR /app

# Install Node deps
COPY package*.json ./
# If you DON'T have package-lock.json, change this to "npm install --production"
RUN npm ci --only=production || npm install --production

# Copy the rest of the project
COPY . .

# Build frontend bundle
RUN npm run build-frontend

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# App listens on 3000 inside the container
EXPOSE 3000

# Start server
CMD ["node", "server.js"]