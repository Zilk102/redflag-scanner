FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS build
WORKDIR /app

ARG VITE_YM_ID
ARG VITE_TELEGRAM_BOT_USERNAME
ARG VITE_PUBLIC_ORIGIN

ENV VITE_YM_ID=$VITE_YM_ID
ENV VITE_TELEGRAM_BOT_USERNAME=$VITE_TELEGRAM_BOT_USERNAME
ENV VITE_PUBLIC_ORIGIN=$VITE_PUBLIC_ORIGIN

COPY . .
RUN npm run build

FROM nginx:1.25-alpine AS runner

COPY ./nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
