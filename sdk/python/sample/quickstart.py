"""
GraphVec Python SDK Quick Start Example

Demonstrates basic CRUD operations and querying.
"""

import asyncio
from graphvec_client import GraphVecClient, GraphVecNotFoundError

HOST = "http://localhost:8080"
API_KEY = "your-api-key"


async def main():
    client = GraphVecClient(base_url=HOST, api_key=API_KEY)

    # 1. Health Check
    print("=== Health Check ===")
    health = await client.health()
    print(f"Status: {health}")

    # 2. Create Nodes
    print("\n=== Create Nodes ===")
    alice = await client.create_node(1, "Alice", props={"age": 30, "city": "NYC"})
    print(f"Created Alice: {alice}")
    alice_id = alice["id"]

    bob = await client.create_node(1, "Bob", props={"age": 25, "city": "SF"})
    print(f"Created Bob: {bob}")
    bob_id = bob["id"]

    # 3. Read Node
    print("\n=== Get Node ===")
    node = await client.get_node(alice_id)
    print(f"Read Alice: {node}")

    # 4. Update Node
    print("\n=== Update Node ===")
    updated = await client.update_node(alice_id, 1, "Alice", props={"age": 31, "city": "NYC"})
    print(f"Updated Alice: {updated}")

    # 5. Create Edge
    print("\n=== Create Edge ===")
    edge = await client.create_edge(alice_id, bob_id, 1, props={"since": "2024"})
    print(f"Created edge: {edge}")

    # 6. Query
    print("\n=== Query ===")
    results = await client.query("MATCH (n) WHERE n.age > 25 RETURN n")
    print(f"Query returned {len(results)} result(s):")
    for row in results:
        print(f"  - {row}")

    # 7. Delete
    print("\n=== Delete Node ===")
    await client.delete_node(alice_id)
    print(f"Deleted node {alice_id}")

    # 8. Verify Deletion
    try:
        await client.get_node(alice_id)
    except GraphVecNotFoundError:
        print(f"Confirmed: node {alice_id} no longer exists")

    await client.close()
    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
