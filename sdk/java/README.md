# GraphVec Java SDK

Java SDK for the GraphVec graph database.

## Features

- Full CRUD operations on nodes and edges
- Pattern-based graph queries and vector search
- Simple HTTP client (Java 11+ `HttpClient`)
- No external dependencies required

## Quick Start

```java
import com.graphvec.client.GraphVecClient;

public class QuickStart {
    public static void main(String[] args) throws Exception {
        GraphVecClient client = new GraphVecClient(
            "http://localhost:8080",
            "your-api-key"
        );

        // Create a node
        GraphNode node = client.createNode(1, "Alice");
        System.out.println("Created: " + node);

        // Query
        var results = client.query("MATCH (n) WHERE n.age > 25 RETURN n");
        for (var row : results) {
            System.out.println("  - " + row);
        }

        // Delete
        client.deleteNode(node.getId());
        System.out.println("Deleted");

        client.close();
    }
}
```

## Building

```bash
# Compile
javac -d target src/main/java/com/graphvec/client/*.java

# Run tests
javac -d target -cp target src/test/java/com/graphvec/client/*.java
java -cp target org.junit.runner.JUnitCore com.graphvec.client.GraphVecClientTest
```
