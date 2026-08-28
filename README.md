# Monopoly Online

Онлайн-версия «Монополии» на React с общей игровой комнатой, WebSocket-синхронизацией и восстановлением сессии после перезагрузки страницы.

В одной комнате могут играть до пяти человек. Игроки занимают места в лобби, задают ник и подтверждают готовность. После начала партии сервер хранит текущее состояние игры и управляет таймерами ходов.

## Технологии

- React 19 и TypeScript;
- Vite для разработки и production-сборки;
- Node.js HTTP/WebSocket-сервер;
- SQLite для лобби, сессий и текущей партии;
- Nginx и systemd для работы на Ubuntu VPS.

## Требования

- Node.js 24 LTS или новее;
- npm;
- два свободных локальных порта: `5173` для Vite и `3001` для игрового сервера.

Проверить версии:

```bash
node --version
npm --version
```

## Локальный запуск

Установите зависимости:

```bash
npm install
```

Для стандартного локального запуска файл `.env` не обязателен. Будут использованы пароль `monopoly`, порт `3001` и каталог `data` внутри проекта.

Запустите сервер в первом терминале:

```bash
npm run dev:server
```

Запустите React-клиент во втором терминале:

```bash
npm run dev
```

Откройте адрес:

```text
http://localhost:5173
```

Vite автоматически перенаправляет `/ws` и `/api` на сервер `http://localhost:3001`.

### Локальные настройки

Чтобы изменить пароль или таймеры, скопируйте пример окружения:

PowerShell:

```powershell
Copy-Item .env.example .env
```

Bash:

```bash
cp .env.example .env
```

Пример `.env`:

```dotenv
GAME_PASSWORD=change-me
HOST=127.0.0.1
PORT=3001
TURN_SECONDS=70
TRADE_SECONDS=35
DEBUG_ONLINE=0
DATA_DIR=./data
```

| Переменная | Назначение |
| --- | --- |
| `GAME_PASSWORD` | Пароль для входа в игровую комнату |
| `HOST` | Адрес, который слушает Node.js-сервер |
| `PORT` | Порт Node.js-сервера |
| `TURN_SECONDS` | Время обычного хода |
| `TRADE_SECONDS` | Время ответа на предложение обмена |
| `DEBUG_ONLINE` | Подробные сетевые логи при значении `1` |
| `DATA_DIR` | Каталог файла `monopoly.sqlite` |

После изменения серверных переменных перезапустите `npm run dev:server`.

## Проверки перед публикацией

```bash
npm run lint
npm run build
npm run test:online
```

- `lint` проверяет TypeScript и React-код;
- `build` создаёт production-клиент в `dist`;
- `test:online` запускает временный сервер и проверяет лобби, WebSocket-синхронизацию, переподключение, обмен и завершение игры.

Production-сборку локально можно проверить так:

```bash
npm run build
npm start
```

После этого приложение будет доступно по адресу `http://127.0.0.1:3001`. В production отдельный Vite-процесс не нужен: Node.js раздаёт содержимое `dist` самостоятельно.

## Архитектура production

```text
Браузер
   │ HTTPS / WSS
   ▼
Nginx :80/:443
   │ HTTP / WebSocket
   ▼
Node.js :3001
   ├── dist/                  React-клиент
   ├── /api/health            проверка состояния
   ├── /api/entropy/fx        серверный источник курса
   ├── /ws                    игровая синхронизация
   └── monopoly.sqlite        лобби, сессии и партия
```

Порт `3001` рекомендуется оставлять доступным только локально. Снаружи пользователи подключаются через Nginx по HTTPS/WSS.

## Развёртывание на Ubuntu VPS

Ниже предполагается домен `monopoly.example.com`, каталог приложения `/opt/monopoly` и каталог данных `/var/lib/monopoly`. Замените домен и адрес репозитория своими значениями.

### 1. Подготовьте DNS и сервер

Создайте `A`-запись домена, направленную на IP-адрес VPS.

Установите Git и Nginx:

```bash
sudo apt update
sudo apt install -y git nginx
```

Установите Node.js 24 LTS и убедитесь, что исполняемый файл находится по пути `/usr/bin/node`:

```bash
node --version
command -v node
```

Если `command -v node` возвращает другой путь, укажите его в `ExecStart` файла `deploy/monopoly.service`.

### 2. Создайте системного пользователя и загрузите проект

```bash
sudo useradd --system --home /opt/monopoly --shell /usr/sbin/nologin monopoly
sudo mkdir -p /opt/monopoly /var/lib/monopoly
sudo git clone <REPOSITORY_URL> /opt/monopoly
sudo chown -R monopoly:monopoly /opt/monopoly /var/lib/monopoly
```

Установите зависимости и соберите клиент:

```bash
cd /opt/monopoly
sudo -u monopoly npm ci
sudo -u monopoly npm run build
```

### 3. Настройте окружение

```bash
sudo cp /opt/monopoly/.env.example /etc/monopoly.env
sudo nano /etc/monopoly.env
sudo chown root:root /etc/monopoly.env
sudo chmod 600 /etc/monopoly.env
```

Production-конфигурация должна выглядеть примерно так:

```dotenv
GAME_PASSWORD=замените-на-длинный-пароль
HOST=127.0.0.1
PORT=3001
TURN_SECONDS=70
TRADE_SECONDS=35
DEBUG_ONLINE=0
DATA_DIR=/var/lib/monopoly
```

### 4. Подключите systemd

```bash
sudo cp /opt/monopoly/deploy/monopoly.service /etc/systemd/system/monopoly.service
sudo systemctl daemon-reload
sudo systemctl enable --now monopoly
sudo systemctl status monopoly
```

Проверьте сервер напрямую:

```bash
curl http://127.0.0.1:3001/api/health
```

Ожидаемый ответ:

```json
{"ok":true}
```

### 5. Подключите Nginx

Скопируйте подготовленный конфиг:

```bash
sudo cp /opt/monopoly/deploy/nginx.conf /etc/nginx/sites-available/monopoly
sudo nano /etc/nginx/sites-available/monopoly
```

Замените `monopoly.example.com` на свой домен, затем включите сайт:

```bash
sudo ln -s /etc/nginx/sites-available/monopoly /etc/nginx/sites-enabled/monopoly
sudo nginx -t
sudo systemctl reload nginx
```

Если на VPS включён UFW, разрешите HTTP/HTTPS, предварительно убедившись, что SSH уже разрешён:

```bash
sudo ufw allow 'Nginx Full'
```

### 6. Включите HTTPS

Установите Certbot по инструкции для своей версии Ubuntu, затем выпустите сертификат:

```bash
sudo certbot --nginx -d monopoly.example.com
sudo certbot renew --dry-run
```

После включения HTTPS клиент автоматически использует `wss://` для WebSocket. Дополнительный `VITE_WS_URL` при такой схеме не требуется.

## Обновление приложения на VPS

```bash
cd /opt/monopoly
sudo -u monopoly git pull --ff-only
sudo -u monopoly npm ci
sudo -u monopoly npm run build
sudo systemctl restart monopoly
sudo systemctl status monopoly
```

Изменения только в React/CSS тоже требуют новой сборки `npm run build`. Изменения сервера или переменных окружения требуют перезапуска systemd-службы.

## Данные и резервное копирование

SQLite находится в каталоге `DATA_DIR`. При production-конфигурации основной файл:

```text
/var/lib/monopoly/monopoly.sqlite
```

Для согласованной файловой копии временно остановите приложение:

```bash
sudo systemctl stop monopoly
sudo tar -czf /root/monopoly-data-backup.tar.gz -C /var/lib monopoly
sudo systemctl start monopoly
```

Не удаляйте каталог данных при обычном обновлении — в нём находятся сессии и незавершённая партия.

## Диагностика

Состояние службы:

```bash
sudo systemctl status monopoly
```

Логи Node.js-сервера:

```bash
sudo journalctl -u monopoly -f
```

Логи Nginx:

```bash
sudo tail -f /var/log/nginx/error.log
```

Проверка конфигурации Nginx:

```bash
sudo nginx -t
```

Для подробной диагностики игровой синхронизации установите `DEBUG_ONLINE=1` в `/etc/monopoly.env` и перезапустите службу:

```bash
sudo systemctl restart monopoly
sudo journalctl -u monopoly -f
```

Если локальный клиент бесконечно показывает «Подключаемся…», проверьте, что одновременно запущены обе команды:

```bash
npm run dev:server
npm run dev
```

## Основные каталоги

```text
src/                 React-клиент и игровая логика
src/online/          лобби и WebSocket-клиент
src/random/          сбор источников случайности
server/              Node.js/WebSocket/SQLite-сервер
deploy/              конфиги systemd и Nginx
pic/                 изображения игровых событий
test/                интеграционный онлайн-тест
data/                локальная SQLite-база, не хранится в Git
dist/                production-сборка, не хранится в Git
```
