#!/usr/bin/env bash
#
# Run ON the nginx EC2 instance (Amazon Linux 2023, ARM) as root after:
#   - Route 53 (or DNS): A record(s) for your domain(s) point to this host's Elastic IP
#   - Security group allows TCP 443 (deploy AwsInfra-Ec2Nginx after CDK adds the rule, or add 443 manually)
#
# Usage:
#   sudo EMAIL='you@example.com' ./on-ec2-certbot-https.example.sh ram-narayanan.com www.ram-narayanan.com
#
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run as root: sudo $0 ..." >&2
  exit 1
fi

if [[ -z "${EMAIL:-}" ]]; then
  echo "Set EMAIL for Let's Encrypt: sudo EMAIL='you@example.com' $0 domain1 [domain2 ...]" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: sudo EMAIL='you@example.com' $0 ram-narayanan.com [www.ram-narayanan.com ...]" >&2
  exit 1
fi

CERTBOT_BIN=(certbot)

install_certbot() {
  if command -v certbot >/dev/null 2>&1; then
    return 0
  fi
  if dnf install -y certbot python3-certbot-nginx 2>/dev/null; then
    return 0
  fi
  echo "dnf install certbot failed; installing via pip (python3.11)..." >&2
  dnf install -y python3.11 python3.11-pip augeas-libs
  python3.11 -m pip install --upgrade pip
  python3.11 -m pip install certbot certbot-nginx
  CERTBOT_BIN=(python3.11 -m certbot)
}

install_certbot

mapfile -t DOMAINS < <(printf '%s\n' "$@")
CERTBOT_ARGS=(--nginx --non-interactive --agree-tos --email "$EMAIL" --redirect)
for d in "${DOMAINS[@]}"; do
  CERTBOT_ARGS+=(-d "$d")
done

"${CERTBOT_BIN[@]}" "${CERTBOT_ARGS[@]}"

nginx -t
systemctl reload nginx

echo ""
echo "Done. Test: https://${DOMAINS[0]}/"
echo "Renewal: certbot renew --dry-run (timer/cron usually installed with certbot)"
