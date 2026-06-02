package com.graphvec.client;

/**
 * Thrown when a requested resource is not found.
 */
public class GraphVecNotFoundException extends GraphVecException {
    public GraphVecNotFoundException(String message) {
        super(message);
    }
}
