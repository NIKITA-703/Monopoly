# Monopoly Online

Онлайн-версия «Монополии» на React с общей игровой комнатой, WebSocket-синхронизацией и восстановлением сессии после перезагрузки страницы.

В одной комнате могут играть до пяти человек. Игроки занимают места в лобби, задают ник и подтверждают готовность. После начала партии сервер хранит текущее состояние игры и управляет таймерами ходов.

Текущая версия приложения задаётся полем `version` в `package.json`. Клиент показывает её на экранах входа и лобби, а сервер публикует через `/api/version` и `/api/health`.

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
HOST=127.0.0.1
PORT=3001
TURN_SECONDS=70
TURN_ACTION_SECONDS=30
TRADE_SECONDS=35
AUCTION_SECONDS=40
LOBBY_DISCONNECT_SECONDS=600
LOBBY_IDLE_SECONDS=900
DEBUG_ONLINE=0
AUDIT_LOG_MAX_BYTES=5242880
AUDIT_LOG_FILES=5
AUDIT_LOG_MAX_AGE_DAYS=14
DATA_DIR=./data
```

| Переменная | Назначение |
| --- | --- |
| `HOST` | Адрес, который слушает Node.js-сервер |
| `PORT` | Порт Node.js-сервера |
| `TURN_SECONDS` | Время обычного хода |
| `TURN_ACTION_SECONDS` | Техническое время на завершение уже начатого броска и анимации |
| `TRADE_SECONDS` | Время ответа на предложение обмена |
| `AUCTION_SECONDS` | Время на ставку или пас одного участника аукциона |
| `LOBBY_DISCONNECT_SECONDS` | Через сколько секунд отсутствия освобождается место игрока в лобби |
| `LOBBY_IDLE_SECONDS` | Через сколько секунд без действий освобождается место подключённого игрока в лобби |
| `DEBUG_ONLINE` | Подробные сетевые логи при значении `1` |
| `AUDIT_LOG_MAX_BYTES` | Максимальный размер одного файла журнала игровых действий |
| `AUDIT_LOG_FILES` | Количество файлов журнала, сохраняемых при ротации |
| `AUDIT_LOG_MAX_AGE_DAYS` | Срок хранения ротированных файлов журнала в днях |
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
- Тот же тест проверяет, что сервер отдаёт версию из `package.json`.

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
    ├── /api/version           версия запущенного сервера
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
sudo git clone https://github.com/NIKITA-703/Monopoly.git /opt/monopoly
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
HOST=127.0.0.1
PORT=3001
TURN_SECONDS=70
TURN_ACTION_SECONDS=30
TRADE_SECONDS=35
AUCTION_SECONDS=40
LOBBY_DISCONNECT_SECONDS=600
LOBBY_IDLE_SECONDS=900
DEBUG_ONLINE=0
AUDIT_LOG_MAX_BYTES=5242880
AUDIT_LOG_FILES=5
AUDIT_LOG_MAX_AGE_DAYS=14
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

Лучше обновлять приложение между партиями. Перезапуск сервера кратковременно разрывает WebSocket-соединения; состояние комнаты и партии хранится в SQLite и не удаляется при обычном обновлении.

### 1. Отправьте изменения в GitHub с компьютера

В каталоге проекта проверьте изменения, выполните проверки и отправьте коммит:

```bash
git status
npm run lint
npm run build
npm run test:online
git add -A
git commit -m "Описание обновления"
git push
```

Если работа выполнялась в отдельной ветке, создайте на GitHub Pull Request в `main`, проверьте его и выполните merge. Обновлять VPS нужно только после появления коммита в удалённой ветке `main`.

Если коммит уже создан и отправлен, повторять `git add` и `git commit` не нужно.

### 2. Проверьте состояние проекта на VPS

Подключитесь к серверу по SSH и убедитесь, что непосредственно на VPS никто не редактировал файлы проекта:

```bash
sudo -u monopoly git -C /opt/monopoly status --short
```

Команда должна ничего не вывести. Если появились изменённые файлы, сначала разберитесь, откуда они взялись. Не выполняйте `git reset --hard`: он удалит эти изменения.

### 3. Подтяните и соберите обновление

```bash
sudo -u monopoly git -C /opt/monopoly fetch origin
sudo -u monopoly git -C /opt/monopoly pull --ff-only origin main
cd /opt/monopoly
sudo -u monopoly npm ci
sudo -u monopoly npm run build
```

`npm ci` приводит зависимости в точное соответствие с `package-lock.json`. Выполнять его при каждом обновлении безопасно, даже если зависимости не менялись.

### 4. Перезапустите приложение и проверьте его

```bash
sudo systemctl restart monopoly
sudo systemctl status monopoly --no-pager
curl --fail http://127.0.0.1:3001/api/health
curl --fail http://127.0.0.1:3001/api/version
sudo journalctl -u monopoly -n 50 --no-pager
```

Ожидаемый ответ проверки здоровья:

```json
{"ok":true,"version":"0.3.0"}
```

Версия в ответе должна совпадать с `version` из `/opt/monopoly/package.json`. Если браузер загрузил клиент другой версии, на экране входа или лобби появится кнопка обновления страницы.

После этого обновите страницу игры в браузере. Изменения React/CSS требуют выполнения `npm run build`, а изменения Node.js-сервера — перезапуска службы. В приведённой инструкции всегда выполняются оба действия, поэтому она подходит для любого обновления.

### Если изменились файлы развёртывания

Если обновлялся `deploy/monopoly.service`, повторно установите его:

```bash
sudo cp /opt/monopoly/deploy/monopoly.service /etc/systemd/system/monopoly.service
sudo systemctl daemon-reload
sudo systemctl restart monopoly
```

Если обновлялся `deploy/nginx.conf`, сравните его со своей production-конфигурацией, сохраните правильный домен и примените:

```bash
sudo cp /opt/monopoly/deploy/nginx.conf /etc/nginx/sites-available/monopoly
sudo nano /etc/nginx/sites-available/monopoly
sudo nginx -t
sudo systemctl reload nginx
```

### Быстро посмотреть доступные обновления без установки

```bash
sudo -u monopoly git -C /opt/monopoly fetch origin
sudo -u monopoly git -C /opt/monopoly log --oneline HEAD..origin/main
```

Каталог `/var/lib/monopoly` и файл `/etc/monopoly.env` находятся вне Git-репозитория, поэтому `git pull` и `npm ci` их не затрагивают.

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

### Статистика попаданий на поля

Каждое завершённое перемещение сохраняется в таблице `landings`: партия, игрок, его цвет, номер поля и тип перемещения. Сводку по самым посещаемым полям и цветам можно получить так:

```bash
sqlite3 /var/lib/monopoly/monopoly.sqlite "SELECT tile_name, player_color, COUNT(*) AS visits FROM landings GROUP BY tile_id, player_color ORDER BY visits DESC;"
```

Статистика одной партии:

```bash
sqlite3 /var/lib/monopoly/monopoly.sqlite "SELECT tile_name, player_name, player_color, COUNT(*) AS visits FROM landings WHERE game_id = 'ID_ПАРТИИ' GROUP BY tile_id, player_id ORDER BY visits DESC;"
```

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

Независимо от `DEBUG_ONLINE`, сервер сохраняет структурированный журнал игровых действий в `DATA_DIR/audit`. Файлы автоматически ограничиваются по размеру и количеству настройками `AUDIT_LOG_MAX_BYTES` и `AUDIT_LOG_FILES`. Пароли, cookie, токены сессий и секреты перед записью скрываются.

Чтобы выгрузить записи одной партии в отдельный файл, укажите её `gameId`:

```bash
npm run logs:game -- GAME_ID > game-log.jsonl
```

Локальные файлы журнала и выгрузки находятся вне Git благодаря `.gitignore`.

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
logo/                оптимизированные WebP-логотипы игровых полей
pic/                 оптимизированные WebP-изображения игровых событий
test/                интеграционный онлайн-тест
data/                локальная SQLite-база, не хранится в Git
dist/                production-сборка, не хранится в Git
```
