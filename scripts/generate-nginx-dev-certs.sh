#!/usr/bin/env bash
# Generates a self-signed TLS certificate for local nginx dev use.
# In production, replace these with certs from your CA or Let's Encrypt.
#
# Usage:
#   bash scripts/generate-nginx-dev-certs.sh [cert-dir]
#
# Default cert-dir: ./nginx/certs
# Outputs:
#   <certs-dir>/server.crt  — certificate (PEM)
#   <certs-dir>/server.key  — private key  (PEM)

set -euo pipefail

CERTS_DIR="${1:-$(dirname "$0")/../nginx/certs}"
DAYS=365
CN="${NGINX_TLS_CN:-localhost}"

echo "Generating nginx dev TLS certificate in ${CERTS_DIR} ..."

mkdir -p "${CERTS_DIR}"
chmod 700 "${CERTS_DIR}"

# Generate private key (2048-bit RSA)
openssl genrsa -out "${CERTS_DIR}/server.key" 2048

# Generate self-signed certificate
openssl req -new -x509 \
  -key "${CERTS_DIR}/server.key" \
  -out "${CERTS_DIR}/server.crt" \
  -days "${DAYS}" \
  -subj "/CN=${CN}" \
  -addext "subjectAltName=DNS:${CN},DNS:localhost,IP:127.0.0.1"

chmod 600 "${CERTS_DIR}/server.key"
chmod 644 "${CERTS_DIR}/server.crt"

echo "Done."
echo "  Certificate : ${CERTS_DIR}/server.crt  (valid ${DAYS} days)"
echo "  Private key : ${CERTS_DIR}/server.key"
echo ""
echo "To enable TLS in dev, uncomment the HTTPS server block in nginx/nginx.dev.conf"
echo "and ensure the certs directory is volume-mounted in docker-compose.yml."
