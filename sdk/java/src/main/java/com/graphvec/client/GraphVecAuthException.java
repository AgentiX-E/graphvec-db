package com.graphvec.client;

/**
 * Thrown when authentication fails.
 */
public class GraphVecAuthException extends GraphVecException {
    public GraphVecAuthException(String message) {
        super(message);
    }
}
