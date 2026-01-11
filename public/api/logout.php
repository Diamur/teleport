<?php
declare(strict_types=1);

require_once __DIR__ . '/_lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
  json_out(['ok' => false, 'error' => 'method_not_allowed'], 405);
}

start_session();
$sid = session_id();
remove_session($sid);

$_SESSION = [];
if (ini_get("session.use_cookies")) {
  $params = session_get_cookie_params();
  setcookie(session_name(), '', time() - 42000, $params["path"], $params["domain"], is_https(), true);
}
session_destroy();

json_out(['ok' => true]);
