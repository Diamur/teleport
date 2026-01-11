<?php
declare(strict_types=1);

// Базовый путь (на случай если проект лежит не в корне домена)
$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
if ($base === '') $base = '';

$uri  = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url($uri, PHP_URL_PATH) ?: '/';

// Если уже в /client — ничего не делаем (чтобы не было редирект-лупа)
$clientPrefix = $base . '/client/';
if (strpos($path, $clientPrefix) === 0) {
    // Можно вывести что-то, но обычно просто молча отдаём 404/или ничего.
    // Здесь просто выходим.
    exit;
}

// Редиректим только когда запрос в корень ("/" или "/index.php")
$root1 = $base . '/';
$root2 = $base . '/index.php';

if ($path === $root1 || $path === $root2) {
    $qs = $_SERVER['QUERY_STRING'] ?? '';
    $target = $clientPrefix . ($qs !== '' ? ('?' . $qs) : '');

    header('Location: ' . $target, true, 302);
    exit;
}

// Если пришли на что-то другое — можно отдать 404 (или тоже редиректить на client)
http_response_code(404);
echo 'Not found';
