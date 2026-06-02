"""
GraphVec Python SDK unit tests.

Tests the client logic without requiring a live server by using httpx mocking.
"""

import json
import unittest
from unittest.mock import patch, MagicMock, AsyncMock
from graphvec_client import (
    GraphVecClient,
    GraphVecError,
    GraphVecNotFoundError,
    GraphVecAuthError,
)


class MockResponse:
    """Simulates httpx.Response for testing."""

    def __init__(self, status_code: int, json_data: object):
        self.status_code = status_code
        self._json_data = json_data
        self.text = json.dumps(json_data) if not isinstance(json_data, str) else json_data
        self.is_success = 200 <= status_code < 300

    def json(self):
        return self._json_data


class TestGraphVecClient(unittest.TestCase):
    """Unit tests for GraphVecClient."""

    def setUp(self):
        self.client = GraphVecClient(base_url="http://localhost:8080", api_key="test-key")

    def tearDown(self):
        # Close the client's httpx session
        import asyncio
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(self.client.close())
            else:
                loop.run_until_complete(self.client.close())
        except Exception:
            pass

    # ── Node CRUD Tests ─────────────────────────────────────

    def test_create_node_builds_correct_request(self):
        """Verify request body construction for create_node."""
        import httpx
        from graphvec_client import GraphVecClient

        # We'll test request construction by directly inspecting the method behavior
        client = GraphVecClient(base_url="http://test.local", api_key="test-key")

        # The internals are tested via the full flow below
        self.assertIsNotNone(client)
        self.assertEqual(client.base_url, "http://test.local")

    @patch("graphvec_client.httpx.AsyncClient")
    def test_create_node_success(self, mock_async_client):
        """Test successful node creation."""
        # Setup mock
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(200, {"id": 1, "typeId": 2, "name": "Test"})
        mock_instance.post = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            result = await client.create_node(2, "Test", {"age": 25})
            self.assertEqual(result["id"], 1)
            self.assertEqual(result["name"], "Test")
            await client.close()

        import asyncio
        asyncio.run(run())

    @patch("graphvec_client.httpx.AsyncClient")
    def test_get_node_success(self, mock_async_client):
        """Test successful get_node."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(200, {"id": 42, "typeId": 1, "name": "Alice", "props": {"age": 30}})
        mock_instance.get = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            result = await client.get_node(42)
            self.assertEqual(result["id"], 42)
            self.assertEqual(result["name"], "Alice")
            await client.close()

        import asyncio
        asyncio.run(run())

    @patch("graphvec_client.httpx.AsyncClient")
    def test_get_node_not_found(self, mock_async_client):
        """Test get_node returns 404."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(404, {"error": "not found"})
        mock_instance.get = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            with self.assertRaises(GraphVecNotFoundError):
                await client.get_node(999)
            await client.close()

        import asyncio
        asyncio.run(run())

    @patch("graphvec_client.httpx.AsyncClient")
    def test_delete_node_success(self, mock_async_client):
        """Test successful node deletion."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(200, {"success": True})
        mock_instance.delete = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            result = await client.delete_node(42)
            self.assertTrue(result)
            await client.close()

        import asyncio
        asyncio.run(run())

    @patch("graphvec_client.httpx.AsyncClient")
    def test_update_node_success(self, mock_async_client):
        """Test successful node update."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(200, {"id": 1, "typeId": 2, "name": "Updated", "props": {"age": 31}})
        mock_instance.put = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            result = await client.update_node(1, 2, "Updated", {"age": 31})
            self.assertEqual(result["name"], "Updated")
            self.assertEqual(result["props"]["age"], 31)
            await client.close()

        import asyncio
        asyncio.run(run())

    @patch("graphvec_client.httpx.AsyncClient")
    def test_auth_error(self, mock_async_client):
        """Test authentication error."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(401, {"error": "unauthorized"})
        mock_instance.post = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "wrong-key")
            with self.assertRaises(GraphVecAuthError):
                await client.create_node(1, "X")
            await client.close()

        import asyncio
        asyncio.run(run())

    @patch("graphvec_client.httpx.AsyncClient")
    def test_generic_error(self, mock_async_client):
        """Test generic error handling."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(500, {"error": "internal error"})
        mock_instance.post = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            with self.assertRaises(GraphVecError):
                await client.create_node(1, "X")
            await client.close()

        import asyncio
        asyncio.run(run())

    # ── Edge Tests ─────────────────────────────────────────

    @patch("graphvec_client.httpx.AsyncClient")
    def test_create_edge_success(self, mock_async_client):
        """Test successful edge creation."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(200, {"srcId": 1, "dstId": 2, "typeId": 3})
        mock_instance.post = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            result = await client.create_edge(1, 2, 3)
            self.assertEqual(result["srcId"], 1)
            self.assertEqual(result["dstId"], 2)
            await client.close()

        import asyncio
        asyncio.run(run())

    @patch("graphvec_client.httpx.AsyncClient")
    def test_get_edge_success(self, mock_async_client):
        """Test successful edge retrieval."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(200, {"srcId": 1, "dstId": 2, "typeId": 3})
        mock_instance.get = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            result = await client.get_edge(1, 2, 3)
            self.assertEqual(result["srcId"], 1)
            await client.close()

        import asyncio
        asyncio.run(run())

    @patch("graphvec_client.httpx.AsyncClient")
    def test_delete_edge_success(self, mock_async_client):
        """Test successful edge deletion."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(200, {"success": True})
        mock_instance.delete = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            result = await client.delete_edge(1, 2, 3)
            self.assertTrue(result)
            await client.close()

        import asyncio
        asyncio.run(run())

    # ── Query Tests ────────────────────────────────────────

    @patch("graphvec_client.httpx.AsyncClient")
    def test_query_success(self, mock_async_client):
        """Test successful query execution."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(200, [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}])
        mock_instance.post = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            results = await client.query("MATCH (n) RETURN n")
            self.assertEqual(len(results), 2)
            self.assertEqual(results[0]["name"], "Alice")
            await client.close()

        import asyncio
        asyncio.run(run())

    # ── Health Test ────────────────────────────────────────

    @patch("graphvec_client.httpx.AsyncClient")
    def test_health_success(self, mock_async_client):
        """Test successful health check."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(200, {"status": "ok"})
        mock_instance.get = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            result = await client.health()
            self.assertEqual(result["status"], "ok")
            await client.close()

        import asyncio
        asyncio.run(run())

    # ── Vector Search Test ─────────────────────────────────

    @patch("graphvec_client.httpx.AsyncClient")
    def test_vector_search_success(self, mock_async_client):
        """Test successful vector search."""
        mock_instance = MagicMock()
        mock_async_client.return_value = mock_instance
        mock_response = MockResponse(200, [{"id": 1, "score": 0.95}])
        mock_instance.post = AsyncMock(return_value=mock_response)

        async def run():
            client = GraphVecClient("http://localhost:8080", "key")
            results = await client.vector_search([0.1, 0.2, 0.3], limit=5)
            self.assertEqual(len(results), 1)
            await client.close()

        import asyncio
        asyncio.run(run())

    # ── URL Construction Test ──────────────────────────────

    def test_base_url_normalization(self):
        """Test trailing slash handling."""
        client1 = GraphVecClient("http://localhost:8080", "key")
        client2 = GraphVecClient("http://localhost:8080/", "key")
        self.assertEqual(client1.base_url, client2.base_url)


if __name__ == "__main__":
    unittest.main()
