# **RedFlag Scanner \- План разработки для Trae AI**

Этот документ содержит пошаговые инструкции для AI-ассистента (Trae) по созданию проекта.

## **Роль AI**

Ты — Senior Fullstack Developer. Мы пишем проект на стеке: React (Vite) \+ Node.js (Express) \+ PostgreSQL \+ Docker. Мы не используем внешние облачные сервисы (кроме YandexGPT API). Весь деплой будет на VPS через Docker Compose.

## **Глобальные переменные и настройки**

* **Язык:** Русский (интерфейс, логи, комментарии).  
* **Стилизация:** Tailwind CSS (Mobile First, Dark Mode).  
* **База данных:** PostgreSQL (локальный контейнер).  
* **AI Provider:** YandexGPT (через axios запрос к https://www.google.com/search?q=https://llm.api.cloud.yandex.net).

## **ШАГ 1: Инициализация проекта и Docker**

**Задача:** Создать структуру монорепозитория и настроить контейнеризацию.

1. Создай структуру папок:  
   * /client (React \+ Vite)  
   * /server (Node.js \+ Express)  
   * /nginx (конфиги nginx)  
2. Создай docker-compose.yml в корне.  
   * Сервис db: image postgres:15-alpine. Пробрось порты, настрой volumes.  
   * Сервис server: build context ./server. Зависит от db. Env variables из файла .env.  
   * Сервис client: build context ./client.  
   * Сервис nginx: image nginx:alpine. Должен проксировать /api на сервис server:5000 и остальное на client:80 (или раздавать статику клиента).  
3. Сгенерируй .env.example с полями:  
   * POSTGRES\_USER, POSTGRES\_PASSWORD, POSTGRES\_DB  
   * YANDEX\_API\_KEY, YANDEX\_FOLDER\_ID  
   * PORT  
   * JWT\_SECRET

## **ШАГ 2: Backend (Server)**

**Задача:** Реализовать API для анализа текста и работы с БД.

1. В папке /server:  
   * npm init \-y  
   * Установи: express, cors, dotenv, pg, axios, yookassa (SDK).  
2. Настройка БД:  
   * Создай таблицу scans (id, text\_content, analysis\_json, is\_paid, created\_at).  
   * Используй чистый pg (node-postgres) или sequelize/prisma (на твой выбор, лучше проще \- pg).  
3. Интеграция YandexGPT:  
   * Создай модуль yandexGpt.js.  
   * Реализуй функцию отправки запроса.  
   * **Важно:** Системный промпт для YandexGPT:"Ты — циничный психолог-эксперт. Проанализируй текст пользователя. Найди признаки манипуляции, газлайтинга, абьюза или любви. Выдай ответ в формате JSON: { rating: число 0-100, verdict: 'краткая фраза', details: 'подробный разбор', advice: 'совет' }. Будь краток и эмоционален."  
4. API Routes:  
   * POST /api/scan: Принимает текст. Если текст короткий (\<500 символов) — анализирует бесплатно (урезанный ответ). Если длинный — требует оплату (возвращает статус payment\_required).  
   * POST /api/pay: Создает платеж в ЮKassa.

## **ШАГ 3: Frontend (Client)**

**Задача:** Создать интерфейс.

1. В папке /client:  
   * npm create vite@latest . \-- \--template react  
   * Установи tailwindcss, postcss, autoprefixer, axios.  
2. Компоненты:  
   * HeroSection: Заголовок "Узнай, кто он(а) на самом деле". Поле textarea для ввода.  
   * ResultCard: Появляется после анализа.  
     * Визуализируй рейтинг токсичности (Progress Bar, красный цвет).  
     * Текст вердикта.  
     * Кнопка "Купить полный разбор" (если версия бесплатная).  
3. Логика:  
   * Отправка текста на бэкенд.  
   * Обработка состояний (Loading, Success, Error).  
   * Анимации появления результатов.

## **ШАГ 4: Сборка и Запуск**

**Задача:** Проверить работоспособность.

1. Напиши скрипт для локального запуска (без докера) для разработки (npm run dev в обоих папках).  
2. Проверь, что Nginx конфиг корректен.

Инструкция для разработчика (меня):  
Выполняй эти шаги последовательно. Начинай с Шага 1\. Не переходи к следующему шагу, пока текущий не будет полностью реализован и протестирован (код компилируется).