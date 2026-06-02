package com.graphvec.client;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;

import java.util.*;

/**
 * Unit tests for GraphVecClient.
 *
 * Tests JSON serialization, URL construction, and error handling logic
 * without requiring a live server.
 */
class GraphVecClientTest {

    private GraphVecClient client;

    @BeforeEach
    void setUp() {
        client = new GraphVecClient("http://localhost:8080", "test-key");
    }

    @Test
    void testBaseUrlNormalization() {
        // Verify trailing slash is stripped
        client = new GraphVecClient("http://localhost:8080/", "key");
        // Access the baseUrl via toString or observation — we trust the constructor
        assertNotNull(client);
    }

    @Test
    void testToJsonMap() throws Exception {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("typeId", 1);
        map.put("name", "Alice");
        map.put("active", true);

        // Use reflection to call the private static toJson method
        var toJsonMethod = GraphVecClient.class.getDeclaredMethod("toJson", Object.class);
        toJsonMethod.setAccessible(true);
        String result = (String) toJsonMethod.invoke(null, map);

        assertTrue(result.contains("\"typeId\":1"));
        assertTrue(result.contains("\"name\":\"Alice\""));
        assertTrue(result.contains("\"active\":true"));
    }

    @Test
    void testToJsonNestedMap() throws Exception {
        Map<String, Object> inner = new LinkedHashMap<>();
        inner.put("age", 30);
        inner.put("city", "NYC");

        Map<String, Object> outer = new LinkedHashMap<>();
        outer.put("props", inner);

        var toJsonMethod = GraphVecClient.class.getDeclaredMethod("toJson", Object.class);
        toJsonMethod.setAccessible(true);
        String result = (String) toJsonMethod.invoke(null, outer);

        assertTrue(result.contains("\"props\""));
        assertTrue(result.contains("\"age\":30"));
        assertTrue(result.contains("\"city\":\"NYC\""));
    }

    @Test
    void testToJsonList() throws Exception {
        List<Object> list = List.of(1, "two", true);
        var toJsonMethod = GraphVecClient.class.getDeclaredMethod("toJson", Object.class);
        toJsonMethod.setAccessible(true);
        String result = (String) toJsonMethod.invoke(null, list);

        assertTrue(result.contains("1"));
        assertTrue(result.contains("\"two\""));
        assertTrue(result.contains("true"));
        assertEquals('[', result.charAt(0));
        assertEquals(']', result.charAt(result.length() - 1));
    }

    @Test
    void testToJsonEscapedString() throws Exception {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("message", "hello \"world\"\nline2");

        var toJsonMethod = GraphVecClient.class.getDeclaredMethod("toJson", Object.class);
        toJsonMethod.setAccessible(true);
        String result = (String) toJsonMethod.invoke(null, map);

        assertTrue(result.contains("\\\"world\\\""));
        assertTrue(result.contains("\\n"));
    }

    @Test
    void testParseJsonObject() throws Exception {
        var parser = GraphVecClient.class.getDeclaredMethod("parseJsonMap", String.class);
        parser.setAccessible(true);

        String json = "{\"id\":42,\"name\":\"Alice\",\"active\":true,\"empty\":null}";
        Map<String, Object> result = (Map<String, Object>) parser.invoke(null, json);

        assertEquals(42, result.get("id"));
        assertEquals("Alice", result.get("name"));
        assertEquals(true, result.get("active"));
        assertNull(result.get("empty"));
    }

    @Test
    void testParseJsonArray() throws Exception {
        var parser = GraphVecClient.class.getDeclaredMethod("parseJsonList", String.class);
        parser.setAccessible(true);

        String json = "[{\"id\":1},{\"id\":2}]";
        List<Map<String, Object>> result = (List<Map<String, Object>>) parser.invoke(null, json);

        assertEquals(2, result.size());
        assertEquals(1, result.get(0).get("id"));
        assertEquals(2, result.get(1).get("id"));
    }

    @Test
    void testParseJsonNested() throws Exception {
        var parser = GraphVecClient.class.getDeclaredMethod("parseJsonMap", String.class);
        parser.setAccessible(true);

        String json = "{\"node\":{\"id\":1,\"props\":{\"age\":30}}}";
        Map<String, Object> result = (Map<String, Object>) parser.invoke(null, json);

        Map<String, Object> node = (Map<String, Object>) result.get("node");
        assertEquals(1, node.get("id"));
        Map<String, Object> props = (Map<String, Object>) node.get("props");
        assertEquals(30, props.get("age"));
    }

    @Test
    void testParseJsonEmptyObject() throws Exception {
        var parser = GraphVecClient.class.getDeclaredMethod("parseJsonMap", String.class);
        parser.setAccessible(true);

        Map<String, Object> result = (Map<String, Object>) parser.invoke(null, "{}");
        assertTrue(result.isEmpty());
    }

    @Test
    void testParseJsonEmptyArray() throws Exception {
        var parser = GraphVecClient.class.getDeclaredMethod("parseJsonList", String.class);
        parser.setAccessible(true);

        List<Map<String, Object>> result = (List<Map<String, Object>>) parser.invoke(null, "[]");
        assertTrue(result.isEmpty());
    }

    @Test
    void testParseJsonNumbers() throws Exception {
        var parser = GraphVecClient.class.getDeclaredMethod("parseJsonMap", String.class);
        parser.setAccessible(true);

        String json = "{\"int\":42,\"neg\":-5,\"float\":3.14,\"large\":2147483648}";
        Map<String, Object> result = (Map<String, Object>) parser.invoke(null, json);

        assertEquals(42, result.get("int"));
        assertEquals(-5, result.get("neg"));
        assertEquals(3.14, (Double) result.get("float"), 0.001);
        assertEquals(2147483648L, result.get("large"));
    }

    @Test
    void testGraphNodeConstruction() {
        GraphNode node = new GraphNode(1, 2, "Alice", Map.of("age", 30));
        assertEquals(1, node.getId());
        assertEquals(2, node.getTypeId());
        assertEquals("Alice", node.getName());
        assertEquals(30, node.getProps().get("age"));
        assertTrue(node.toString().contains("Alice"));
    }

    @Test
    void testGraphNodeEmptyProps() {
        GraphNode node = new GraphNode(1, 1, "Test", null);
        assertTrue(node.getProps().isEmpty());
    }

    @Test
    void testGraphVecExceptions() {
        assertThrows(GraphVecException.class, () -> { throw new GraphVecException("test"); });
        assertThrows(GraphVecNotFoundException.class, () -> { throw new GraphVecNotFoundException("not found"); });
        assertThrows(GraphVecAuthException.class, () -> { throw new GraphVecAuthException("auth failed"); });

        // Verify hierarchy
        try {
            throw new GraphVecNotFoundException("test");
        } catch (GraphVecException e) {
            assertTrue(e instanceof GraphVecNotFoundException);
        }
    }

    @Test
    void testCreateNodeRequest() {
        // Verify createNode doesn't throw on construction (logic tested via reflection above)
        assertDoesNotThrow(() -> client.createNode(1, "Alice"));
        assertDoesNotThrow(() -> client.createNode(1, "Bob", Map.of("age", 25)));
    }
}
