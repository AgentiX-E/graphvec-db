# Docker Deployment for AgentiX GraphVec

Multi-node deployment using Docker Compose with mutual TLS (mTLS) authentication.

## Prerequisites

- Docker Engine 24+
- Docker Compose v2
- `openssl` CLI (for certificate generation)

## Quick Start

```bash
# 1. Generate self-signed certificates
bash scripts/init-certs.sh

# 2. Build and start the cluster (3 nodes)
docker compose up -d

# 3. Check status
docker compose ps
docker compose logs -f

# 4. Test a node's health
curl -k https://localhost:443/api/health
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  Docker Compose Cluster                     │
│                                              │
│  node-1 (seed)                              │
│  ├─ REST API: localhost:443                 │
│  └─ Admin UI: localhost:8080                │
│                                              │
│  node-2                                     │
│  ├─ REST API: localhost:4443                │
│  └─ Admin UI: localhost:8081                │
│                                              │
│  node-3                                     │
│  ├─ REST API: localhost:4453                │
│  └─ Admin UI: localhost:8082                │
└─────────────────────────────────────────────┘
```

All nodes are connected through `graphvec-net` bridge network and use the same CA-signed certificates for inter-node mTLS communication.

## Configuration

Each node supports the following environment variables:

| Variable     | Description                          | Default     |
|-------------|--------------------------------------|-------------|
| `NODE_ID`   | Unique node identifier               | auto        |
| `NODE_HOST` | Node hostname                        | node-N      |
| `NODE_PORT` | mTLS server port                     | 443         |
| `PEERS`     | Comma-separated peer hostnames       | all nodes   |
| `DATA_DIR`  | Data storage path                    | /data       |
| `TLS_CERT`  | Server certificate path              | /config/certs/server-cert.pem |
| `TLS_KEY`   | Server private key path              | /config/certs/server-key.pem  |
| `TLS_CA`    | CA certificate path                  | /config/certs/ca-cert.pem     |
| `AUTH_MODE` | Authentication mode (mtls/jwt)       | mtls        |
| `ADMIN_PORT`| Admin UI web server port             | 8080        |
| `LOG_LEVEL` | Log level (debug/info/warn/error)    | info        |

## Production Considerations

1. **Certificates**: Replace self-signed certs with real CA-signed certificates
2. **Persistence**: Data volumes (`node1-data`, `node2-data`, `node3-data`) persist across restarts
3. **Backup**: Regularly backup `/data` directories
4. **Monitoring**: Enable Prometheus metrics on `/metrics` endpoint
5. **Scaling**: For more nodes, update `PEERS` and add ports accordingly
6. **Security**: Do not expose ports to the internet without a reverse proxy

## Troubleshooting

```bash
# View logs
docker compose logs -f node-1

# Restart a specific node
docker compose restart node-2

# Reset data volumes (⚠️ destroys data)
docker compose down -v

# Rebuild images
docker compose build --no-cache

# Check certificate validity
openssl x509 -in certs/server-cert.pem -text -noout
```
