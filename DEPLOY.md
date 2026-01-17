# DEPLOY (Ubuntu/Debian)

Инструкция рассчитана на VPS/выделенный сервер с Ubuntu 22.04/24.04 (аналогично для Debian). Проект запускается через Docker Compose.

## 1) Подготовка сервера

### 1.1 Обновить пакеты

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg git
```

### 1.2 Установить Docker Engine (официальный репозиторий)

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Проверка:

```bash
docker --version
docker compose version
```

Чтобы запускать Docker без `sudo`:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

### 1.3 (Опционально) Docker Compose v1 для `deploy.sh`

В проекте есть скрипт [deploy.sh](file:///D:/PROJECT/project1/deploy.sh), который вызывает `docker-compose` (v1). Если хочешь запускать именно его без правок — установи `docker-compose`.

Вариант через GitHub releases (пример):

```bash
sudo curl -L "https://github.com/docker/compose/releases/download/v2.24.6/docker-compose-linux-x86_64" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
docker-compose --version
```

Если не ставить `docker-compose`, можно запускать проект командой `docker compose ...` вручную (см. ниже).

### 1.4 (Нужно для deploy.sh) Установить Node.js для сборки фронта

Скрипт `deploy.sh` собирает фронтенд на сервере (`client/dist` монтируется в nginx контейнер), поэтому на сервере нужен Node.js.

Пример для Node.js 20 LTS:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node -v
npm -v
```

## 2) Запуск проекта

### 2.1 Получить код на сервер

Вариант A — Git:

```bash
git clone <URL_РЕПОЗИТОРИЯ> project1
cd project1
```

Вариант B — SCP (пример):

```bash
scp -r ./project1 user@SERVER_IP:/home/user/project1
```

Вариант C — FileZilla:

- Подключись по SFTP.
- Загрузи папку проекта целиком на сервер.

### 2.2 Создать `.env` на сервере

В корне проекта создай `.env` рядом с `docker-compose.yml`.

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Минимальный набор переменных (обязательные):

```env
# PostgreSQL
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=redflag_scanner

# Backend
PORT=5000

# YandexGPT (нужен YANDEX_FOLDER_ID и один из ключей/токенов)
YANDEX_FOLDER_ID=
YANDEX_API_KEY=
YANDEX_CLOUD_API_KEY=
YANDEX_IAM_TOKEN=

# ЮKassa
YOOKASSA_SHOP_ID=
YOOKASSA_SECRET_KEY=

# Куда ЮKassa возвращает пользователя после оплаты.
# Должен быть URL фронтенда (страница, где открыт App), например:
# http://YOUR_DOMAIN/
YOOKASSA_RETURN_URL=http://localhost/

# (опционально) Метрика
VITE_YM_ID=
```

Примечание про `YOOKASSA_RETURN_URL`: приложение ожидает, что после успешной оплаты будет добавлен параметр `payment=success`.

### 2.3 Сборка фронта и запуск контейнеров

Вариант A — через `deploy.sh`:

```bash
chmod +x deploy.sh
./deploy.sh
```

Вариант B — руками (Docker Compose v2):

```bash
cd client
npm ci
npm run build
cd ..

docker compose up -d --build
```

Проверка статуса:

```bash
docker compose ps
```

Проверка доступности:

```bash
curl -I http://localhost/
```

## 3) Полезные команды

### 3.1 Логи

Логи всего стека:

```bash
docker compose logs -f
```

Логи конкретного сервиса:

```bash
docker compose logs -f nginx
docker compose logs -f server
docker compose logs -f db
```

Если нужно через `docker logs`:

```bash
docker ps
docker logs -f <CONTAINER_ID>
```

### 3.2 Перезапуск

Перезапуск контейнеров:

```bash
docker compose restart
```

Пересобрать и перезапустить после обновления кода:

```bash
git pull
cd client && npm ci && npm run build && cd ..
docker compose up -d --build
```

### 3.3 Перезагрузка сервера

```bash
sudo reboot
```

