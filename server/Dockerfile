FROM node:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-rus tesseract-ocr-data-eng fontconfig ttf-dejavu

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

RUN npm i --no-save prisma@6.19.2

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src

USER node

EXPOSE 5000
CMD ["npm", "run", "start"]
