<?php
declare(strict_types=1);

require_once __DIR__ . '/_lib.php';

$me = get_me_or_401();
$users = read_users();
$onlineMap = get_online_map();

$out = [];
$now = time();

foreach ($users as $login => $_pass) {
  $last = $onlineMap[$login] ?? 0;
  $online = ($last > 0) && (($now - $last) <= ONLINE_TTL_SECONDS);

  $out[] = [
    'login' => $login,
    'status' => $online ? 'online' : 'offline',
    'lastSeen' => $last,
  ];
}

$onlineCount = 0;
foreach ($out as $u) if ($u['status'] === 'online') $onlineCount++;

json_out([
  'ok' => true,
  'me' => $me['login'],
  'onlineCount' => $onlineCount,
  'ttl' => ONLINE_TTL_SECONDS,
  'users' => $out,
]);
