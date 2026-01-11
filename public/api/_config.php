<?php
declare(strict_types=1);

/**
 * Настройки MVP.
 * Файлы лежат в /public_html/data (рядом с /api и /client).
 * На nginx рекомендую закрыть прямой доступ к /data (location ^~ /data { deny all; }).
 */

const DATA_DIR = __DIR__ . '/../data';
const USERS_FILE = DATA_DIR . '/users.ini';
const SESSIONS_FILE = DATA_DIR . '/sessions';

// Через сколько секунд без ping пользователь считается "Не в сети"
const ONLINE_TTL_SECONDS = 25;

// Максимальная длина логина/пароля для простого MVP
const MAX_LOGIN_LEN = 32;
const MAX_PASS_LEN  = 64;
