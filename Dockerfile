# Use a small Node image
FROM node:22-slim

# Install system dependencies: ffmpeg + Python + yt-dlp
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip && \
    pip3 install yt-dlp && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Install Node deps
COPY package*.json ./
RUN npm install --production

# Copy the rest of the project
COPY . .

# Build frontend bundle
RUN npm run build-frontend

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Your app listens on 3000 inside the container
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
