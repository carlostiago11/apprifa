#!/bin/sh
set -eu

if [ "${DB_HOST:-}" != mysql-test ] || [ "${DB_NAME:-}" != apprifa_test ] || [ "${PAYMENT_PROVIDER:-}" != mock ]; then
  echo 'This script requires the disposable CI database and mock payments.' >&2
  exit 1
fi

node --test tests/pix.test.js
node server.js > /tmp/apprifa-ci-server.log 2>&1 &
server_pid=$!
cleanup() {
  status=$?
  trap - EXIT
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    cat /tmp/apprifa-ci-server.log >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node <<'JS'
(async () => {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:3000/api/health', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('CI application did not become ready');
})().catch(error => { console.error(error); process.exitCode = 1; });
JS

API_BASE=http://127.0.0.1:3000 node --test tests/api.test.js
# Reuses the schema initialized by server.js, with simulated gateway responses.
node --test tests/pix.integration.test.js
