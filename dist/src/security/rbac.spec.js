"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const rbac_1 = require("./rbac");
const types_1 = require("../types");
describe('RBAC', () => {
    describe('ADMIN role', () => {
        test('should have all permissions (checkPermission does not throw)', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.ADMIN, 'read')).not.toThrow();
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.ADMIN, 'write')).not.toThrow();
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.ADMIN, 'delete')).not.toThrow();
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.ADMIN, 'compact')).not.toThrow();
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.ADMIN, 'backup')).not.toThrow();
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.ADMIN, 'restore')).not.toThrow();
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.ADMIN, 'reshard')).not.toThrow();
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.ADMIN, 'health')).not.toThrow();
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.ADMIN, 'audit')).not.toThrow();
        });
        test('should have access to all resources', () => {
            expect(() => rbac_1.RBAC.checkResourceAccess(types_1.Role.ADMIN, 'write:graph')).not.toThrow();
            expect(() => rbac_1.RBAC.checkResourceAccess(types_1.Role.ADMIN, 'read:graph')).not.toThrow();
        });
        test('getPermissions should return [* (all)]', () => {
            const perms = rbac_1.RBAC.getPermissions(types_1.Role.ADMIN);
            expect(perms).toEqual(['* (all)']);
        });
    });
    describe('READER role', () => {
        test('should be able to read', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.READER, 'read')).not.toThrow();
        });
        test('should NOT be able to write', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.READER, 'write')).toThrow(types_1.AuthError);
        });
        test('should NOT be able to delete', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.READER, 'delete')).toThrow(types_1.AuthError);
        });
        test('should NOT be able to compact', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.READER, 'compact')).toThrow(types_1.AuthError);
        });
        test('should NOT be able to backup', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.READER, 'backup')).toThrow(types_1.AuthError);
        });
        test('checkResourceAccess should reject write resources', () => {
            expect(() => rbac_1.RBAC.checkResourceAccess(types_1.Role.READER, 'write:data')).toThrow(types_1.AuthError);
        });
        test('checkResourceAccess should allow read resources', () => {
            expect(() => rbac_1.RBAC.checkResourceAccess(types_1.Role.READER, 'read:data')).not.toThrow();
        });
        test('getPermissions should list only read', () => {
            const perms = rbac_1.RBAC.getPermissions(types_1.Role.READER);
            expect(perms).toEqual(['read']);
        });
    });
    describe('WRITER role', () => {
        test('should be able to read', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.WRITER, 'read')).not.toThrow();
        });
        test('should be able to write', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.WRITER, 'write')).not.toThrow();
        });
        test('should be able to delete', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.WRITER, 'delete')).not.toThrow();
        });
        test('should NOT be able to compact', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.WRITER, 'compact')).toThrow(types_1.AuthError);
        });
        test('should NOT be able to backup', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.WRITER, 'backup')).toThrow(types_1.AuthError);
        });
        test('should NOT be able to restore', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.WRITER, 'restore')).toThrow(types_1.AuthError);
        });
        test('should NOT be able to reshard', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.WRITER, 'reshard')).toThrow(types_1.AuthError);
        });
        test('should NOT be able to run health checks', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.WRITER, 'health')).toThrow(types_1.AuthError);
        });
        test('getPermissions should list read, write, delete', () => {
            const perms = rbac_1.RBAC.getPermissions(types_1.Role.WRITER);
            expect(perms).toEqual(['read', 'write', 'delete']);
        });
    });
    describe('OPERATOR role', () => {
        test('should be able to read', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.OPERATOR, 'read')).not.toThrow();
        });
        test('should be able to write', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.OPERATOR, 'write')).not.toThrow();
        });
        test('should be able to delete', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.OPERATOR, 'delete')).not.toThrow();
        });
        test('should be able to compact', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.OPERATOR, 'compact')).not.toThrow();
        });
        test('should be able to backup', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.OPERATOR, 'backup')).not.toThrow();
        });
        test('should be able to restore', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.OPERATOR, 'restore')).not.toThrow();
        });
        test('should be able to reshard', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.OPERATOR, 'reshard')).not.toThrow();
        });
        test('should be able to check health', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.OPERATOR, 'health')).not.toThrow();
        });
        test('should be able to read metrics', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.OPERATOR, 'metrics')).not.toThrow();
        });
        test('should be able to read audit logs', () => {
            expect(() => rbac_1.RBAC.checkPermission(types_1.Role.OPERATOR, 'audit')).not.toThrow();
        });
        test('getPermissions should list all operator capabilities', () => {
            const perms = rbac_1.RBAC.getPermissions(types_1.Role.OPERATOR);
            expect(perms).toContain('read');
            expect(perms).toContain('write');
            expect(perms).toContain('delete');
            expect(perms).toContain('compact');
            expect(perms).toContain('backup');
            expect(perms).toContain('restore');
            expect(perms).toContain('reshard');
        });
    });
    describe('Error details', () => {
        test('checkPermission should throw AuthError with statusCode 403', () => {
            try {
                rbac_1.RBAC.checkPermission(types_1.Role.READER, 'write');
                fail('Should have thrown');
            }
            catch (e) {
                expect(e).toBeInstanceOf(types_1.AuthError);
                expect(e.statusCode).toBe(403);
                expect(e.message).toContain('reader');
                expect(e.message).toContain('write');
            }
        });
        test('checkResourceAccess should throw AuthError with statusCode 403', () => {
            try {
                rbac_1.RBAC.checkResourceAccess(types_1.Role.READER, 'write:data');
                fail('Should have thrown');
            }
            catch (e) {
                expect(e).toBeInstanceOf(types_1.AuthError);
                expect(e.statusCode).toBe(403);
            }
        });
    });
});
//# sourceMappingURL=rbac.spec.js.map