# Monopoly Online

Онлайн-версия «Монополии» на React с независимыми игровыми комнатами, WebSocket-синхронизацией и восстановлением сессии после перезагрузки страницы.

На одном сервере может одновременно работать несколько партий. В комнате могут играть до пяти человек. Игроки выбирают места, задают ники и подтверждают готовность, после чего лидер комнаты запускает матч. Сервер изолирует состояние и события каждой комнаты, хранит текущую партию и управляет игровыми таймерами.

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
npm ci
```

Для стандартного локального запуска файл `.env` не обязателен. Будут использованы адрес `0.0.0.0`, порт `3001`, стандартные значения таймеров и каталог `data` внутри проекта. Сообщение `.env not found. Continuing without it.` не останавливает запуск. Чтобы слушать только локальный адрес, скопируйте `.env.example` в `.env` по инструкции ниже.

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

### Какую команду использовать

| Сценарий | Запуск | Окружение |
| --- | --- | --- |
| Локальная разработка | `npm run dev:server` и `npm run dev` в разных терминалах | Необязательный `.env` в корне проекта |
| Проверка собранного приложения | `npm run build`, затем `npm start` | Необязательный `.env` в корне проекта |
| VPS с установленной службой | `sudo systemctl restart monopoly` | Обязательный `/etc/monopoly.env` |

На VPS процессом игры управляет systemd. Параллельный запуск `npm start` или `npm run dev:server` на том же порту завершится ошибкой `EADDRINUSE`. Для локальной проверки production-сборки сначала остановите `dev:server` через Ctrl+C. Команда `npm run preview` запускает только просмотр сборки Vite и не заменяет игровой сервер.

### Комнаты и запуск игры

После подключения открывается список комнат. Можно:

- создать публичную комнату, которая появится в общем списке;
- создать закрытую комнату с кодом и паролем;
- подключиться по коду или ссылке-приглашению вида `?room=ABC123`.

Создатель становится лидером комнаты. Все участники выбирают места и нажимают «Я готов». Когда подключены минимум два игрока и все готовы, лидер нажимает «Начать игру». При выходе лидера его роль передаётся следующему участнику. После завершения партии игроки возвращаются в ту же комнату.

### Книжный бонус

Испытание из «Шанса» даёт $1 000k за каждое выпадение, если игрок доходит до следующего старта без трат. Повторные выпадения до выплаты складываются: два дают $2 000k сверх обычной награды за старт. Трата денег отменяет все накопленные книжные бонусы; после выплаты они снимаются. Сумма показана в чате и на значке эффекта, условия — в подсказке при наведении. Старое сохранение с одним активным флагом учитывается как один бонус; прежние повторные выпадения, которые не сохранялись счётчиком, восстановить автоматически нельзя.

### Локальные настройки

Чтобы изменить порт, таймеры или параметры журналов, скопируйте пример окружения:

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
| `LEGACY_SINGLE_ROOM` | `0` или отсутствие переменной — несколько комнат; `1` — прежний режим одной комнаты, используемый в `test:online` |
| `NODE_ENV` | В production-шаблоне задано `production`; отдельного переключения игровой логики по этой переменной нет |
| `VITE_WS_URL` | Необязательный адрес WebSocket клиента, задаётся при сборке; обычно не нужен |

После изменения серверных переменных перезапустите `npm run dev:server`.

Таймеры задаются в секундах. Если меняете `PORT` для разработки, обновите также адреса прокси `/api` и `/ws` в `vite.config.ts`. На VPS порт должен совпадать с `proxy_pass` в Nginx. При изменении production-каталога `DATA_DIR` обновите также `ReadWritePaths` в службе systemd и права на каталог.

## Проверки перед публикацией

```bash
npm run lint
npm run build
npm run test:rooms
npm run test:online
```

- `lint` проверяет TypeScript и React-код;
- `build` создаёт production-клиент в `dist`;
- `npm run test:static` пересобирает клиент и проверяет выдачу логотипа Louis Vuitton по URL с `%20`, тип и содержимое картинки, обработку некорректных путей;
- `npm run test:effects` проверяет размер и накопление книжных бонусов, серверную проверку выплаты, совместимость старых эффектов и защиту от повторного начисления;
- `test:rooms` проверяет создание, вход, пароли комнат, лидерство, готовность, запуск и изоляцию параллельных партий;
- тот же `test:rooms` проверяет повторную выдачу автохода после истечения таймера: новое задание получает новый ID, просроченное задание отклоняется, после успешной обработки запускается следующий таймер;
- `test:online` запускает временный сервер в прежнем режиме одной комнаты (`LEGACY_SINGLE_ROOM=1`) и проверяет лобби, WebSocket-синхронизацию, переподключение, обмен, завершение игры и версию сервера из `package.json`. Для текущего режима нескольких комнат запускайте также `test:rooms`.

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

Если `command -v node` возвращает другой путь, укажите его в `ExecStart` файла `deploy/monopoly.service`. Node.js должен быть доступен системному пользователю `monopoly` вне `/root` и `/home`: служба использует `ProtectHome=true`.

### 2. Создайте системного пользователя и загрузите проект

Эти команды предназначены для первой установки. Если проект уже клонирован и служба настроена, используйте раздел обновления ниже.

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

При первой установке создайте файл из шаблона. При обновлении редактируйте существующий `/etc/monopoly.env`, сохраняя свои значения.

```bash
sudo cp /opt/monopoly/deploy/monopoly.env.example /etc/monopoly.env
sudo nano /etc/monopoly.env
sudo chown root:root /etc/monopoly.env
sudo chmod 600 /etc/monopoly.env
```

Production-конфигурация должна выглядеть примерно так:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
LEGACY_SINGLE_ROOM=0
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

Готовый шаблон — `deploy/monopoly.env.example`. `LEGACY_SINGLE_ROOM=0` оставляет включённым текущий режим нескольких комнат. `NODE_ENV=production` задаёт стандартный режим окружения Node.js; игровой сервер отдельно эту переменную не проверяет.

Служба `deploy/monopoly.service` обязательно читает `/etc/monopoly.env`: без этого файла systemd не запустит сервер. Файл `.env` в каталоге проекта эта служба не загружает. Каталог `/var/lib/monopoly` должен существовать и быть доступен пользователю `monopoly` для записи. После изменения окружения выполните `sudo systemctl restart monopoly`.

Для схемы с одним доменом через Nginx переменная `VITE_WS_URL` не нужна: клиент подключается к `/ws` на текущем домене. Если она была задана при сборке клиента, удалите переопределение из окружения сборки и пересоберите клиент командой `npm run build`. Изменение `/etc/monopoly.env` не меняет уже собранный клиент.

### 4. Подключите systemd

```bash
sudo cp /opt/monopoly/deploy/monopoly.service /etc/systemd/system/monopoly.service
sudo systemctl daemon-reload
sudo systemctl enable --now monopoly
sudo systemctl status monopoly
```

Проверьте сервер напрямую:

```bash
curl --fail http://127.0.0.1:3001/api/health
```

Ожидаемый ответ:

```json
{"ok":true,"version":"0.3.0"}
```

Значение `version` соответствует `package.json` запущенной версии. После настройки службы используйте `systemctl` для запуска и перезапуска приложения.

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
npm run test:rooms
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

Если обновлялся `deploy/nginx.conf`, перенесите необходимые изменения в действующий конфиг, сохранив свой домен, HTTPS-блок и настройки сертификатов. Шаблон в репозитории содержит только HTTP, поэтому не заменяйте им целиком конфигурацию, уже настроенную Certbot:

```bash
sudo nano /etc/nginx/sites-available/monopoly
sudo nginx -t
sudo systemctl reload nginx
```

Если обновился шаблон окружения, добавьте нужные переменные в `/etc/monopoly.env` и выполните `sudo systemctl restart monopoly`. Для изменения только env команда `daemon-reload` не требуется.

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
npm run --silent logs:game -- GAME_ID > game-log.jsonl
```

На VPS явно загрузите production-окружение; команда выше читает только локальный `.env`:

```bash
sudo /usr/bin/node --env-file=/etc/monopoly.env /opt/monopoly/server/export-game-log.mjs GAME_ID > game-log.jsonl
```

Локальные файлы журнала и выгрузки находятся вне Git благодаря `.gitignore`.

### `.env not found. Continuing without it.`

Это предупреждение команды `npm start` или `npm run dev:server`: локальный `.env` отсутствует, запуск продолжается со значениями по умолчанию и переменными текущего процесса. Создать локальный файл можно командой `cp .env.example .env`. Служба systemd использует отдельный `/etc/monopoly.env`; создавать локальный `.env` для неё не нужно.

### `EADDRINUSE: address already in use 0.0.0.0:3001`

Порт `3001` уже занят другим процессом. Если ошибка появилась после ручного запуска `npm run dev:server`, завершите команду через Ctrl+C: режим `--watch` после ошибки остаётся ждать изменений файлов. Затем проверьте владельца порта и службу:

```bash
sudo ss -ltnp 'sport = :3001'
sudo systemctl status monopoly --no-pager
curl --fail http://127.0.0.1:3001/api/health
```

Если порт занимает работающая служба `monopoly` и проверка здоровья успешна, используйте её. Второй экземпляр сервера не нужен. Если порт занимает другой процесс, определите его назначение по PID из `ss` перед остановкой. Ошибка запуска второго экземпляра сама по себе не объясняет, почему браузер не подключается к первому.

### Бесконечное «Подключаемся…»

Если в production клиент бесконечно показывает «Подключаемся…», это означает, что клиент не завершил подключение и получение состояния. Сам экран не позволяет определить причину: клиент автоматически повторяет попытки. Сначала проверьте запуск сервера:

```bash
sudo systemctl status monopoly --no-pager
sudo journalctl -u monopoly -n 50 --no-pager
curl --fail http://127.0.0.1:3001/api/health
```

Если служба сообщает об отсутствии файла окружения, создайте `/etc/monopoly.env` по инструкции выше и перезапустите её. Если локальный `/api/health` отвечает, проверьте `https://ВАШ-ДОМЕН/api/health` и запрос `/ws` во вкладке Network → WS инструментов разработчика браузера. Успешное WebSocket-подключение возвращает HTTP `101`. Если его нет, проверьте активную конфигурацию Nginx для домена, включая HTTPS: маршрут `/ws` должен передавать заголовки `Upgrade` и `Connection`, как в `deploy/nginx.conf`.

| Результат проверки | Следующий шаг |
| --- | --- |
| Локальный `/api/health` недоступен | Проверить журнал службы, env, владельца порта и права на `DATA_DIR` |
| Локальный `/api/health` работает, через домен — нет | Проверить DNS, активный сайт Nginx и его upstream |
| Через домен `/api/health` работает, `/ws` не получает `101` | Проверить WebSocket-прокси в активном HTTP/HTTPS-блоке и адрес запроса в браузере |
| `/ws` получает `101`, но экран остаётся | Проверить сообщения WebSocket, ошибки Console и журнал Node.js; соединение ещё не гарантирует успешную авторизацию и получение состояния |

Если запрос WebSocket уходит на другой домен или порт, проверьте `VITE_WS_URL` в окружении сборки. Для обычного развёртывания удалите это переопределение и заново выполните `npm run build`.

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
deploy/              конфиги systemd, Nginx и production-шаблон env
logo/                оптимизированные WebP-логотипы игровых полей
pic/                 оптимизированные WebP-изображения игровых событий
test/                тесты комнат и онлайн-протокола
data/                локальная SQLite-база, не хранится в Git
dist/                production-сборка, не хранится в Git
```
