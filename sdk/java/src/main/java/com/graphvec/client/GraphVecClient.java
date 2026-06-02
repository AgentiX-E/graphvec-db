package com.graphvec.client;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.CompletableFuture;

/**
 * Java HTTP client for the GraphVec graph database.
 *
 * <p>Provides synchronous CRUD operations for nodes and edges,
 * plus graph query execution.</p>
 */
public class GraphVecClient implements AutoCloseable {

    private final String baseUrl;
    private final String apiKey;
    private final HttpClient httpClient;
    private static final Duration TIMEOUT = Duration.ofSeconds(30);

    /**
     * Create a new GraphVec client.
     *
     * @param baseUrl Server base URL, e.g. "http://localhost:8080"
     * @param apiKey  API key for authentication
     */
    public GraphVecClient(String baseUrl, String apiKey) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.apiKey = apiKey;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(TIMEOUT)
                .build();
    }

    // ── Node CRUD ──────────────────────────────────────────

    /**
     * Create a new node.
     *
     * @param typeId Node type identifier
     * @param name   Node name
     * @param props  Optional node properties (may be null)
     * @return The created node
     */
    public GraphNode createNode(int typeId, String name, Map<String, Object> props) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("typeId", typeId);
        body.put("name", name);
        if (props != null && !props.isEmpty()) {
            body.put("props", props);
        }

        String json = post("/api/graph/nodes", body);
        return GraphNode.fromJson(json);
    }

    public GraphNode createNode(int typeId, String name) {
        return createNode(typeId, name, null);
    }

    /**
     * Get a node by ID.
     *
     * @param nodeId Node identifier
     * @return The node data
     * @throws GraphVecNotFoundException if the node does not exist
     */
    public GraphNode getNode(int nodeId) {
        String json = get("/api/graph/node/" + nodeId);
        return GraphNode.fromJson(json);
    }

    /**
     * Update an existing node.
     *
     * @param nodeId Node identifier
     * @param typeId Updated node type
     * @param name   Updated node name
     * @param props  Optional updated properties
     * @return The updated node
     */
    public GraphNode updateNode(int nodeId, int typeId, String name, Map<String, Object> props) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("typeId", typeId);
        body.put("name", name);
        if (props != null && !props.isEmpty()) {
            body.put("props", props);
        }

        String json = put("/api/graph/node/" + nodeId, body);
        return GraphNode.fromJson(json);
    }

    /**
     * Delete a node by ID.
     *
     * @param nodeId Node identifier
     * @return true if deletion was successful
     */
    public boolean deleteNode(int nodeId) {
        delete("/api/graph/node/" + nodeId);
        return true;
    }

    // ── Edge Operations ────────────────────────────────────

    /**
     * Create an edge between two nodes.
     *
     * @param srcId  Source node ID
     * @param dstId  Destination node ID
     * @param typeId Edge type identifier
     * @param props  Optional edge properties
     * @return The created edge data as a map
     */
    public Map<String, Object> createEdge(int srcId, int dstId, int typeId, Map<String, Object> props) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("srcId", srcId);
        body.put("dstId", dstId);
        body.put("typeId", typeId);
        if (props != null && !props.isEmpty()) {
            body.put("props", props);
        }

        String json = post("/api/graph/edges", body);
        return parseJsonMap(json);
    }

    /**
     * Execute a Cypher-style query.
     *
     * @param queryString The query to execute
     * @return List of result rows as maps
     */
    public List<Map<String, Object>> query(String queryString) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("query", queryString);

        String json = post("/api/graph/query", body);
        return parseJsonList(json);
    }

    /**
     * Perform vector similarity search.
     *
     * @param vector    Embedding vector
     * @param limit     Maximum number of results
     * @param threshold Optional similarity threshold
     * @return List of matching nodes with similarity scores
     */
    public List<Map<String, Object>> vectorSearch(List<Double> vector, int limit, Double threshold) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("vector", vector);
        body.put("limit", limit);
        if (threshold != null) {
            body.put("threshold", threshold);
        }

        String json = post("/api/graph/vectore-search", body);
        return parseJsonList(json);
    }

    /**
     * Check server health.
     *
     * @return Health status as a map
     */
    public Map<String, Object> health() {
        String json = get("/api/health");
        return parseJsonMap(json);
    }

    @Override
    public void close() {
        // HttpClient is AutoCloseable in Java 21+, but for compatibility we do nothing
        // and let it be garbage collected
    }

    // ── HTTP Methods ───────────────────────────────────────

    private String get(String path) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + path))
                    .header("Authorization", "Bearer " + apiKey)
                    .header("Accept", "application/json")
                    .timeout(TIMEOUT)
                    .GET()
                    .build();

            HttpResponse<String> response = httpClient.send(request,
                    HttpResponse.BodyHandlers.ofString());
            handleErrors(response);
            return response.body();
        } catch (Exception e) {
            throw new GraphVecException("GET " + path + " failed: " + e.getMessage(), e);
        }
    }

    private String post(String path, Map<String, Object> body) {
        try {
            String jsonBody = toJson(body);
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + path))
                    .header("Authorization", "Bearer " + apiKey)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .timeout(TIMEOUT)
                    .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
                    .build();

            HttpResponse<String> response = httpClient.send(request,
                    HttpResponse.BodyHandlers.ofString());
            handleErrors(response);
            return response.body();
        } catch (Exception e) {
            throw new GraphVecException("POST " + path + " failed: " + e.getMessage(), e);
        }
    }

    private String put(String path, Map<String, Object> body) {
        try {
            String jsonBody = toJson(body);
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + path))
                    .header("Authorization", "Bearer " + apiKey)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .timeout(TIMEOUT)
                    .PUT(HttpRequest.BodyPublishers.ofString(jsonBody))
                    .build();

            HttpResponse<String> response = httpClient.send(request,
                    HttpResponse.BodyHandlers.ofString());
            handleErrors(response);
            return response.body();
        } catch (Exception e) {
            throw new GraphVecException("PUT " + path + " failed: " + e.getMessage(), e);
        }
    }

    private void delete(String path) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + path))
                    .header("Authorization", "Bearer " + apiKey)
                    .header("Accept", "application/json")
                    .timeout(TIMEOUT)
                    .DELETE()
                    .build();

            HttpResponse<String> response = httpClient.send(request,
                    HttpResponse.BodyHandlers.ofString());
            handleErrors(response);
        } catch (Exception e) {
            throw new GraphVecException("DELETE " + path + " failed: " + e.getMessage(), e);
        }
    }

    // ── Error Handling ─────────────────────────────────────

    private void handleErrors(HttpResponse<String> response) {
        int status = response.statusCode();
        if (status >= 200 && status < 300) return;

        if (status == 404) {
            throw new GraphVecNotFoundException("Resource not found: " + response.body());
        } else if (status == 401 || status == 403) {
            throw new GraphVecAuthException("Authentication failed: " + response.body());
        } else {
            throw new GraphVecException("HTTP " + status + ": " + response.body());
        }
    }

    // ── JSON Parsing (lightweight, no dependency) ──────────

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parseJsonMap(String json) {
        return (Map<String, Object>) parseJsonValue(json);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> parseJsonList(String json) {
        Object parsed = parseJsonValue(json);
        if (parsed instanceof List) {
            return (List<Map<String, Object>>) parsed;
        }
        throw new GraphVecException("Expected JSON array but got: " + json.substring(0, Math.min(50, json.length())));
    }

    private static Object parseJsonValue(String json) {
        JsonParser parser = new JsonParser(json.trim());
        return parser.parseValue();
    }

    private static String toJson(Object obj) {
        if (obj == null) return "null";
        if (obj instanceof String) return "\"" + escapeJson((String) obj) + "\"";
        if (obj instanceof Number || obj instanceof Boolean) return obj.toString();
        if (obj instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) obj;
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<String, Object> entry : map.entrySet()) {
                if (!first) sb.append(",");
                sb.append("\"").append(escapeJson(entry.getKey())).append("\":");
                sb.append(toJson(entry.getValue()));
                first = false;
            }
            sb.append("}");
            return sb.toString();
        }
        if (obj instanceof List) {
            List<?> list = (List<?>) obj;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append(toJson(list.get(i)));
            }
            sb.append("]");
            return sb.toString();
        }
        return "\"" + escapeJson(obj.toString()) + "\"";
    }

    private static String escapeJson(String s) {
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }

    // ── Simple JSON Parser (recursive descent) ─────────────

    private static class JsonParser {
        private final String json;
        private int pos;

        JsonParser(String json) {
            this.json = json;
            this.pos = 0;
        }

        Object parseValue() {
            skipWhitespace();
            if (pos >= json.length()) return null;
            char c = json.charAt(pos);
            switch (c) {
                case '{': return parseObject();
                case '[': return parseArray();
                case '"': return parseString();
                case 't': case 'f': return parseBoolean();
                case 'n': return parseNull();
                default: return parseNumber();
            }
        }

        private Map<String, Object> parseObject() {
            Map<String, Object> map = new LinkedHashMap<>();
            pos++; // skip '{'
            skipWhitespace();
            if (json.charAt(pos) == '}') { pos++; return map; }

            while (pos < json.length()) {
                skipWhitespace();
                String key = parseString();
                skipWhitespace();
                pos++; // skip ':'
                Object value = parseValue();
                map.put(key, value);
                skipWhitespace();
                if (json.charAt(pos) == '}') { pos++; return map; }
                pos++; // skip ','
            }
            return map;
        }

        private List<Object> parseArray() {
            List<Object> list = new ArrayList<>();
            pos++; // skip '['
            skipWhitespace();
            if (json.charAt(pos) == ']') { pos++; return list; }

            while (pos < json.length()) {
                list.add(parseValue());
                skipWhitespace();
                if (json.charAt(pos) == ']') { pos++; return list; }
                pos++; // skip ','
            }
            return list;
        }

        private String parseString() {
            pos++; // skip opening '"'
            StringBuilder sb = new StringBuilder();
            while (pos < json.length()) {
                char c = json.charAt(pos);
                if (c == '"') { pos++; return sb.toString(); }
                if (c == '\\') {
                    pos++;
                    if (pos < json.length()) {
                        char next = json.charAt(pos);
                        switch (next) {
                            case '"': sb.append('"'); break;
                            case '\\': sb.append('\\'); break;
                            case '/': sb.append('/'); break;
                            case 'b': sb.append('\b'); break;
                            case 'f': sb.append('\f'); break;
                            case 'n': sb.append('\n'); break;
                            case 'r': sb.append('\r'); break;
                            case 't': sb.append('\t'); break;
                            case 'u':
                                // Simple unicode escape (4 hex digits)
                                if (pos + 4 < json.length()) {
                                    String hex = json.substring(pos + 1, pos + 5);
                                    sb.append((char) Integer.parseInt(hex, 16));
                                    pos += 4;
                                }
                                break;
                            default: sb.append(next);
                        }
                        pos++;
                    }
                } else {
                    sb.append(c);
                    pos++;
                }
            }
            return sb.toString();
        }

        private Number parseNumber() {
            int start = pos;
            if (json.charAt(pos) == '-') pos++;
            while (pos < json.length() && Character.isDigit(json.charAt(pos))) pos++;
            boolean isDecimal = false;
            if (pos < json.length() && json.charAt(pos) == '.') {
                isDecimal = true;
                pos++;
                while (pos < json.length() && Character.isDigit(json.charAt(pos))) pos++;
            }
            if (pos < json.length() && (json.charAt(pos) == 'e' || json.charAt(pos) == 'E')) {
                isDecimal = true;
                pos++;
                if (pos < json.length() && (json.charAt(pos) == '+' || json.charAt(pos) == '-')) pos++;
                while (pos < json.length() && Character.isDigit(json.charAt(pos))) pos++;
            }
            String numStr = json.substring(start, pos);
            if (isDecimal) return Double.parseDouble(numStr);
            long val = Long.parseLong(numStr);
            if (val >= Integer.MIN_VALUE && val <= Integer.MAX_VALUE) return (int) val;
            return val;
        }

        private Boolean parseBoolean() {
            if (json.startsWith("true", pos)) { pos += 4; return true; }
            if (json.startsWith("false", pos)) { pos += 5; return false; }
            throw new GraphVecException("Invalid boolean at position " + pos);
        }

        private Object parseNull() {
            if (json.startsWith("null", pos)) { pos += 4; return null; }
            throw new GraphVecException("Invalid null at position " + pos);
        }

        private void skipWhitespace() {
            while (pos < json.length() && Character.isWhitespace(json.charAt(pos))) pos++;
        }
    }
}
