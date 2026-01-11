# teleport-server

WebSocket signaling server for TelePort.

## Run (local)
npm i
HOST=127.0.0.1 PORT=3000 node index.js

## Production (systemd)
Service: /etc/systemd/system/teleport.service
Nginx proxy:
- https://w-tp.ru/ws/
- https://w-tp.ru/socket.io/
