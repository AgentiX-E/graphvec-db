package com.graphvec.client;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Collections;

/**
 * Represents a GraphVec node.
 */
public class GraphNode {
    private final int id;
    private final int typeId;
    private final String name;
    private final Map<String, Object> props;

    public GraphNode(int id, int typeId, String name, Map<String, Object> props) {
        this.id = id;
        this.typeId = typeId;
        this.name = name;
        this.props = props != null ? props : Map.of();
    }

    public int getId() { return id; }
    public int getTypeId() { return typeId; }
    public String getName() { return name; }
    public Map<String, Object> getProps() { return props; }

    @Override
    public String toString() {
        return "GraphNode{id=" + id + ", typeId=" + typeId + ", name='" + name + "', props=" + props + "}";
    }

    /**
     * Parse a JSON response into a GraphNode.
     * Expects the JSON to contain "id", "typeId", "name", and optionally "props" fields.
     */
    @SuppressWarnings("unchecked")
    static GraphNode fromJson(String json) {
        Map<String, Object> map;
        // Handle the json being a stringified response
        if (json == null || json.trim().isEmpty()) {
            throw new GraphVecException("Empty JSON response");
        }

        try {
            map = GraphVecClient.parseJsonMap(json);
        } catch (Exception e) {
            throw new GraphVecException("Failed to parse node JSON: " + json, e);
        }

        int id = 0;
        int typeId = 0;
        String name = "";
        Map<String, Object> props = Map.of();

        if (map.get("id") != null) id = ((Number) map.get("id")).intValue();
        if (map.get("typeId") != null) typeId = ((Number) map.get("typeId")).intValue();
        if (map.get("name") != null) name = (String) map.get("name");
        if (map.get("props") != null) props = (Map<String, Object>) map.get("props");

        return new GraphNode(id, typeId, name, props);
    }
}
