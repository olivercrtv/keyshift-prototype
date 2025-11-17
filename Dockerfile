# Use Node with Debian Bookworm
FROM node:22-bookworm

# Install ffmpeg + Python + venv tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-venv \
      python3-pip \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create a virtualenv just for yt-dlp and install latest
RUN python3 -m venv /opt/yt-dlp-venv && \
    /opt/yt-dlp-venv/bin/pip install --no-cache-dir yt-dlp && \
    ln -s /opt/yt-dlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp

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