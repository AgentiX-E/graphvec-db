package com.graphvec.client;

/**
 * Base exception for GraphVec client errors.
 */
public class GraphVecException extends RuntimeException {
    public GraphVecException(String message) {
        super(message);
    }

    public GraphVecException(String message, Throwable cause) {
        super(message, cause);
    }
}
