#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Начало обновления..."

if [ -d .git ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Рабочая директория грязная. Убери локальные правки перед обновлением:"
    git status --porcelain
    exit 1
  fi

  git fetch origin
  git pull --ff-only
fi

echo "📦 Сборка фронтенда..."
(cd client && npm ci --no-audit --no-fund && npm run build)

echo "🔄 Перезапуск Docker..."
DOCKER_PROFILE="${DOCKER_PROFILE:-edge}"
docker compose --profile "$DOCKER_PROFILE" up -d --build

echo "✅ Готово!"
