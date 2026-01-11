<?php
declare(strict_types=1);

require_once __DIR__ . '/_lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
  json_out(['ok' => false, 'error' => 'method_not_allowed'], 405);
}

$body = get_json_body();
$login = safe_str($body['login'] ?? '', MAX_LOGIN_LEN);
$pass  = is_string($body['password'] ?? null) ? (string)$body['password'] : '';
$pass  = trim($pass);
if (mb_strlen($pass) > MAX_PASS_LEN) $pass = mb_substr($pass, 0, MAX_PASS_LEN);

$users = read_users();

if ($login === '' || $pass === '' || !isset($users[$login]) || $users[$login] !== $pass) {
  json_out(['ok' => false, 'error' => 'bad_credentials'], 403);
}

start_session();
// чтобы не было подмены sid
session_regenerate_id(true);

$_SESSION['login'] = $login;
mark_session_active($login, session_id());

json_out(['ok' => true, 'login' => $login]);
