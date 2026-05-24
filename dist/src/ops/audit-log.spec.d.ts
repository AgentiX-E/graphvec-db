interface AuditEntry {
    timestamp: string;
    hlcTimestamp?: string;
    operation: string;
    user: string;
    role: string;
    resource: string;
    result: 'success' | 'denied' | 'error';
    latencyMs?: number;
    details?: string;
}
declare class AuditLog {
    private entries;
    log(entry: Omit<AuditEntry, 'timestamp'>): void;
    query(opts?: {
        operation?: string;
        user?: string;
        result?: 'success' | 'denied' | 'error';
        startTime?: number;
        endTime?: number;
        limit?: number;
    }): AuditEntry[];
    clear(): void;
    size(): number;
}
//# sourceMappingURL=audit-log.spec.d.ts.map