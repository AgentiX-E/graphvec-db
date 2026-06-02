# GraphVec Python SDK

Asynchronous Python SDK for the GraphVec graph database.

## Features

- Full async/await support via `httpx`
- CRUD operations on nodes and edges
- Pattern-based graph queries and vector search
- Fluent query builder API
- Type hints throughout

## Installation

```bash
pip install httpx
```

## Quick Start

```python
import asyncio
from graphvec_client import GraphVecClient

async def main():
    client = GraphVecClient(base_url="http://localhost:8080", api_key="your-api-key")

    # Create a node
    node = await client.create_node(type_id=1, name="Alice", props={"age": 30})
    print(f"Created node: {node}")

    # Get a node
    node = await client.get_node(node["id"])
    print(f"Got node: {node}")

    # Query nodes
    results = await client.query("MATCH (n) WHERE n.age > 25 RETURN n")
    for row in results:
        print(f"  - {row}")

    # Delete a node
    success = await client.delete_node(node["id"])
    print(f"Deleted: {success}")

    await client.close()

asyncio.run(main())
```

## API Reference

### GraphVecClient

- `__init__(base_url, api_key, timeout=30)` — Initialize client
- `async create_node(type_id, name, props=None)` — Create a node
- `async get_node(node_id)` — Get a node by ID
- `async update_node(node_id, type_id, name, props=None)` — Update a node
- `async delete_node(node_id)` — Delete a node
- `async query(query_string)` — Execute a raw query
- `async close()` — Close the HTTP session
