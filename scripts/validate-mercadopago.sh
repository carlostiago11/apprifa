#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${1:-.env}"

echo "[1/3] Validando configuracao do Mercado Pago em ${ENV_FILE} ..."
npm run check:mercadopago -- "$ENV_FILE"

echo "[2/3] Executando testes locais de payload e criptografia ..."
npm run test:pix

echo "[3/3] Executando integracao PIX em banco isolado ..."
npm run test:pix:isolated

echo "Pre-homologacao concluida: nenhum pagamento externo foi criado."