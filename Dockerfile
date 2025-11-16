# Use Node with Debian Bookworm (has yt-dlp in apt)
FROM node:22-bookworm

# Install ffmpeg + yt-dlp from Debian packages (NO pip)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      yt-dlp \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Install Node dependencies (all, including dev, so esbuild is available)
COPY package*.json ./
RUN npm install

# If you have a package-lock.json, npm ci is ideal; otherwise fallback to npm install
RUN npm ci --only=production || npm install --production

# Copy the rest of the project into the container
COPY . .

# Build the frontend bundle
RUN npm run build-frontend

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose the internal port
EXPOSE 3000

# Start the Node server
CMD ["node", "server.js"]