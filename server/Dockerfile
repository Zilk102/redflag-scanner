FROM node:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-rus tesseract-ocr-data-eng

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src

USER node

EXPOSE 5000
CMD ["npm", "run", "start"]
