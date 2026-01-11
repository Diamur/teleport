<?php
declare(strict_types=1);

require_once __DIR__ . '/_lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
  json_out(['ok' => false, 'error' => 'method_not_allowed'], 405);
}

$me = get_me_or_401();
json_out(['ok' => true, 'login' => $me['login'], 'ts' => time()]);
