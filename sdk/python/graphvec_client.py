"""
GraphVec Python SDK — Asynchronous Graph Database Client

Uses httpx for HTTP communication with the GraphVec server.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
import httpx


class GraphVecError(Exception):
    """Base exception for GraphVec client errors."""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


class GraphVecNotFoundError(GraphVecError):
    """Raised when a requested resource is not found."""
    pass


class GraphVecAuthError(GraphVecError):
    """Raised when authentication fails."""
    pass


class GraphVecClient:
    """Async client for GraphVec graph database.

    Args:
        base_url: Base URL of the GraphVec server (e.g. "http://localhost:8080").
        api_key: API key for authentication.
        timeout: Request timeout in seconds (default 30).
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=httpx.Timeout(timeout),
        )

    async def close(self) -> None:
        """Close the underlying HTTP session."""
        await self._client.aclose()

    # ── Node CRUD ──────────────────────────────────────────

    async def create_node(
        self,
        type_id: int,
        name: str,
        props: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Create a new node.

        Args:
            type_id: Node type identifier.
            name: Node name.
            props: Optional node properties.

        Returns:
            Created node with assigned ID.
        """
        body: Dict[str, Any] = {"typeId": type_id, "name": name}
        if props:
            body["props"] = props

        response = await self._client.post("/api/graph/nodes", json=body)
        self._handle_errors(response)
        return response.json()

    async def get_node(self, node_id: int) -> Dict[str, Any]:
        """Get a node by ID.

        Args:
            node_id: Node identifier.

        Returns:
            Node data.

        Raises:
            GraphVecNotFoundError: If the node does not exist.
        """
        response = await self._client.get(f"/api/graph/node/{node_id}")
        self._handle_errors(response)
        return response.json()

    async def update_node(
        self,
        node_id: int,
        type_id: int,
        name: str,
        props: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Update an existing node.

        Args:
            node_id: Node identifier.
            type_id: Updated node type.
            name: Updated node name.
            props: Optional updated properties.

        Returns:
            Updated node data.
        """
        body: Dict[str, Any] = {"typeId": type_id, "name": name}
        if props:
            body["props"] = props

        response = await self._client.put(f"/api/graph/node/{node_id}", json=body)
        self._handle_errors(response)
        return response.json()

    async def delete_node(self, node_id: int) -> bool:
        """Delete a node by ID.

        Args:
            node_id: Node identifier.

        Returns:
            True if deletion was successful.
        """
        response = await self._client.delete(f"/api/graph/node/{node_id}")
        self._handle_errors(response)
        return True

    # ── Edge Operations ────────────────────────────────────

    async def create_edge(
        self,
        src_id: int,
        dst_id: int,
        type_id: int,
        props: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Create an edge between two nodes.

        Args:
            src_id: Source node ID.
            dst_id: Destination node ID.
            type_id: Edge type identifier.
            props: Optional edge properties.

        Returns:
            Created edge data.
        """
        body: Dict[str, Any] = {
            "srcId": src_id,
            "dstId": dst_id,
            "typeId": type_id,
        }
        if props:
            body["props"] = props

        response = await self._client.post("/api/graph/edges", json=body)
        self._handle_errors(response)
        return response.json()

    async def get_edge(self, src_id: int, dst_id: int, type_id: int) -> Dict[str, Any]:
        """Get an edge by its composite key.

        Args:
            src_id: Source node ID.
            dst_id: Destination node ID.
            type_id: Edge type identifier.

        Returns:
            Edge data.
        """
        response = await self._client.get(
            f"/api/graph/edge/{src_id}/{dst_id}/{type_id}"
        )
        self._handle_errors(response)
        return response.json()

    async def delete_edge(self, src_id: int, dst_id: int, type_id: int) -> bool:
        """Delete an edge.

        Args:
            src_id: Source node ID.
            dst_id: Destination node ID.
            type_id: Edge type identifier.

        Returns:
            True if deletion was successful.
        """
        response = await self._client.delete(
            f"/api/graph/edge/{src_id}/{dst_id}/{type_id}"
        )
        self._handle_errors(response)
        return True

    # ── Query ──────────────────────────────────────────────

    async def query(self, query_string: str) -> List[Dict[str, Any]]:
        """Execute a Cypher-style query.

        Args:
            query_string: The query to execute.

        Returns:
            List of result rows.
        """
        response = await self._client.post(
            "/api/graph/query",
            json={"query": query_string},
        )
        self._handle_errors(response)
        return response.json()

    async def vector_search(
        self,
        vector: List[float],
        limit: int = 10,
        threshold: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """Perform vector similarity search.

        Args:
            vector: Embedding vector for similarity search.
            limit: Maximum number of results.
            threshold: Optional similarity threshold.

        Returns:
            List of matching nodes with similarity scores.
        """
        body: Dict[str, Any] = {
            "vector": vector,
            "limit": limit,
        }
        if threshold is not None:
            body["threshold"] = threshold

        response = await self._client.post("/api/graph/vectore-search", json=body)
        self._handle_errors(response)
        return response.json()

    # ── Health Check ───────────────────────────────────────

    async def health(self) -> Dict[str, Any]:
        """Check server health.

        Returns:
            Health status object.
        """
        response = await self._client.get("/api/health")
        self._handle_errors(response)
        return response.json()

    # ── Error Handling ────────────────────────────────────

    @staticmethod
    def _handle_errors(response: httpx.Response) -> None:
        """Convert HTTP errors to typed GraphVec exceptions."""
        if response.is_success:
            return

        status = response.status_code
        if status == 404:
            raise GraphVecNotFoundError(response.text, status)
        elif status == 401 or status == 403:
            raise GraphVecAuthError(response.text, status)
        else:
            raise GraphVecError(response.text, status)
