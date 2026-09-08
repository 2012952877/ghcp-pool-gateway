#!/usr/bin/env bash
# Generate a self-signed signing certificate + key for the SAML IdP (dev only).
set -euo pipefail

DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
mkdir -p "$DIR"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$DIR/idp-key.pem" \
  -out "$DIR/idp-cert.pem" \
  -days 3650 \
  -subj "/CN=local-emu-idp"

echo "Wrote:"
echo "  $DIR/idp-key.pem"
echo "  $DIR/idp-cert.pem"
chmod 600 "$DIR/idp-key.pem"
