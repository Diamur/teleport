<?php
declare(strict_types=1);

require_once __DIR__ . '/_config.php';

function is_https(): bool {
  if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return true;
  if (!empty($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443) return true;
  if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') return true;
  return false;
}

function start_session(): void {
  // безопаснее для HTTPS
  $params = session_get_cookie_params();
  session_set_cookie_params([
    'lifetime' => 0,
    'path' => $params['path'] ?? '/',
    'domain' => $params['domain'] ?? '',
    'secure' => is_https(),
    'httponly' => true,
    'samesite' => 'Lax',
  ]);
  if (session_status() !== PHP_SESSION_ACTIVE) {
    session_start();
  }
}

function json_out(array $data, int $code = 200): void {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

function get_json_body(): array {
  $raw = file_get_contents('php://input');
  if ($raw === false || trim($raw) === '') return [];
  $data = json_decode($raw, true);
  return is_array($data) ? $data : [];
}

function safe_str($v, int $maxLen): string {
  $s = is_string($v) ? trim($v) : '';
  if ($s === '') return '';
  if (mb_strlen($s) > $maxLen) $s = mb_substr($s, 0, $maxLen);
  // простая фильтрация
  $s = preg_replace('/[^\p{L}\p{N}_\.\-]/u', '', $s) ?? '';
  return $s;
}

function read_users(): array {
  if (!file_exists(USERS_FILE)) return [];

  $raw = file_get_contents(USERS_FILE);
  if ($raw === false) return [];

  // Поддержка INI формата Den=1234
  if (strpos($raw, '=') !== false) {
    $ini = @parse_ini_file(USERS_FILE, false, INI_SCANNER_RAW);
    if (is_array($ini)) {
      $out = [];
      foreach ($ini as $k => $v) {
        $login = safe_str($k, MAX_LOGIN_LEN);
        $pass  = is_string($v) ? trim($v) : '';
        if ($login !== '' && $pass !== '') $out[$login] = $pass;
      }
      return $out;
    }
  }

  // Формат: "Den 1234"
  $lines = preg_split('/\r?\n/', $raw);
  $out = [];
  foreach ($lines as $line) {
    $line = trim($line);
    if ($line === '' || $line[0] === '#') continue;
    $parts = preg_split('/\s+/', $line);
    if (!$parts || count($parts) < 2) continue;
    $login = safe_str($parts[0], MAX_LOGIN_LEN);
    $pass  = trim($parts[1]);
    if ($login !== '' && $pass !== '') $out[$login] = $pass;
  }
  return $out;
}

function read_sessions(): array {
  if (!file_exists(SESSIONS_FILE)) return [];
  $raw = file_get_contents(SESSIONS_FILE);
  if ($raw === false || trim($raw) === '') return [];
  $data = json_decode($raw, true);
  return is_array($data) ? $data : [];
}

function write_sessions(array $sessions): void {
  if (!is_dir(DATA_DIR)) @mkdir(DATA_DIR, 0775, true);

  $tmp = SESSIONS_FILE . '.tmp';
  $json = json_encode($sessions, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  if ($json === false) $json = '[]';
  file_put_contents($tmp, $json, LOCK_EX);
  rename($tmp, SESSIONS_FILE);
}

function cleanup_sessions(array $sessions, int $now): array {
  $out = [];
  foreach ($sessions as $s) {
    if (!is_array($s)) continue;
    $last = isset($s['lastSeen']) ? (int)$s['lastSeen'] : 0;
    if ($last > 0 && ($now - $last) <= ONLINE_TTL_SECONDS) {
      $out[] = $s;
    }
  }
  return $out;
}

function mark_session_active(string $login, string $sid): void {
  $now = time();
  $sessions = read_sessions();
  $sessions = cleanup_sessions($sessions, $now);

  $found = false;
  foreach ($sessions as &$s) {
    if (($s['sid'] ?? '') === $sid) {
      $s['login'] = $login;
      $s['lastSeen'] = $now;
      $found = true;
      break;
    }
  }
  unset($s);

  if (!$found) {
    $sessions[] = [
      'login' => $login,
      'sid' => $sid,
      'lastSeen' => $now,
    ];
  }

  write_sessions($sessions);
}

function remove_session(string $sid): void {
  $sessions = read_sessions();
  $out = [];
  foreach ($sessions as $s) {
    if (!is_array($s)) continue;
    if (($s['sid'] ?? '') === $sid) continue;
    $out[] = $s;
  }
  write_sessions($out);
}

function get_me_or_401(): array {
  start_session();
  $login = $_SESSION['login'] ?? '';
  $sid = session_id();

  if (!is_string($login) || trim($login) === '') {
    json_out(['ok' => false, 'error' => 'not_authorized'], 401);
  }
  $login = safe_str($login, MAX_LOGIN_LEN);
  if ($login === '') {
    json_out(['ok' => false, 'error' => 'not_authorized'], 401);
  }

  // обновляем активность
  mark_session_active($login, $sid);

  return ['login' => $login, 'sid' => $sid];
}

function get_online_map(): array {
  $now = time();
  $sessions = cleanup_sessions(read_sessions(), $now);

  // map login => lastSeen (берём самый свежий)
  $map = [];
  foreach ($sessions as $s) {
    if (!is_array($s)) continue;
    $login = safe_str($s['login'] ?? '', MAX_LOGIN_LEN);
    $last = (int)($s['lastSeen'] ?? 0);
    if ($login === '' || $last <= 0) continue;
    if (!isset($map[$login]) || $map[$login] < $last) $map[$login] = $last;
  }
  // сохраняем "очищенный" файл
  write_sessions($sessions);

  return $map;
}
