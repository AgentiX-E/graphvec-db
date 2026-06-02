#!/bin/bash
# ============================================================
# init-certs.sh — Generate self-signed CA + server/client certs
# ============================================================
# For development/testing only. Production deployments should
# use proper CA-signed certificates.
#
# Output (in ./certs/):
#   ca-cert.pem       — CA certificate (trust anchor)
#   ca-key.pem        — CA private key
#   server-cert.pem   — Server certificate (CN=server)
#   server-key.pem    — Server private key
#   client-cert.pem   — Admin client certificate (CN=test-admin)
#   client-key.pem    — Admin client private key
#   client-reader-cert.pem — Reader client certificate (CN=test-reader)
#   client-reader-key.pem  — Reader client private key
#   client-cert-req.csr     — Admin client CSR (temp)
#   client-reader-cert-req.csr — Reader client CSR (temp)
#   server-cert-req.csr     — Server CSR (temp)
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="${SCRIPT_DIR}/../certs"

mkdir -p "${CERTS_DIR}"
cd "${CERTS_DIR}"

echo "=== Generating CA ==="
# CA key
openssl genrsa -out ca-key.pem 4096 2>/dev/null
# CA certificate (valid for 10 years)
openssl req -x509 -new -nodes \
  -key ca-key.pem \
  -sha256 -days 3650 \
  -out ca-cert.pem \
  -subj "/CN=AgentiX GraphVec Test CA" \
  2>/dev/null

echo "=== Generating server certificate ==="
openssl genrsa -out server-key.pem 2048 2>/dev/null
openssl req -new \
  -key server-key.pem \
  -out server-cert-req.csr \
  -subj "/CN=localhost" \
  2>/dev/null
openssl x509 -req \
  -in server-cert-req.csr \
  -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial \
  -out server-cert.pem \
  -days 3650 -sha256 \
  -extfile <(cat <<EOF
subjectAltName=DNS:localhost,DNS:node-1,DNS:node-2,DNS:node-3,IP:127.0.0.1
EOF
) 2>/dev/null

echo "=== Generating admin client certificate (CN=test-admin) ==="
openssl genrsa -out client-key.pem 2048 2>/dev/null
openssl req -new \
  -key client-key.pem \
  -out client-cert-req.csr \
  -subj "/CN=test-admin" \
  2>/dev/null
openssl x509 -req \
  -in client-cert-req.csr \
  -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial \
  -out client-cert.pem \
  -days 3650 -sha256 \
  2>/dev/null

echo "=== Generating reader client certificate (CN=test-reader) ==="
openssl genrsa -out client-reader-key.pem 2048 2>/dev/null
openssl req -new \
  -key client-reader-key.pem \
  -out client-reader-cert-req.csr \
  -subj "/CN=test-reader" \
  2>/dev/null
openssl x509 -req \
  -in client-reader-cert-req.csr \
  -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial \
  -out client-reader-cert.pem \
  -days 3650 -sha256 \
  2>/dev/null

# Clean up CSR files
rm -f server-cert-req.csr client-cert-req.csr client-reader-cert-req.csr

echo "=== Done ==="
echo "Certificates generated in: ${CERTS_DIR}"
echo ""
echo "Files:"
ls -lh ca-*.pem server-*.pem client-*.pem
echo ""
echo "For Docker Compose:"
echo "  docker compose up -d"
