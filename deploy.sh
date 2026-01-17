#!/bin/bash
echo "Building client..."
cd client && npm install && npm run build && cd ..
echo "Starting Docker containers..."
docker-compose down
docker-compose up -d --build
echo "Deployment complete!"
