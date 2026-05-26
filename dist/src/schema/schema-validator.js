"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateNodeType = validateNodeType;
exports.validateEdgeType = validateEdgeType;
/**
 * 校验节点属性是否符合 Schema
 */
function validateNodeType(typeId, props, schema) {
    const typeDef = schema.nodeTypes.find(t => t.typeId === typeId);
    if (!typeDef) {
        return { valid: true, errors: [] }; // 未定义的 typeId 不做校验
    }
    return _validateFields(typeDef.fields ?? [], props, typeDef.name);
}
/**
 * 校验边属性是否符合 Schema
 */
function validateEdgeType(typeId, props, schema) {
    const typeDef = schema.edgeTypes.find(t => t.typeId === typeId);
    if (!typeDef) {
        return { valid: true, errors: [] };
    }
    return _validateFields(typeDef.fields ?? [], props, typeDef.name);
}
function _validateFields(fields, props, typeName) {
    const errors = [];
    const fieldMap = new Map(fields.map(f => [f.name, f]));
    for (const field of fields) {
        const val = props[field.name];
        const isProvided = val !== undefined && val !== null;
        // 必填检查
        if (field.required && !isProvided) {
            errors.push(`[${typeName}] 缺少必填字段: ${field.name}`);
            continue;
        }
        // 类型检查（有值时才做）
        if (isProvided) {
            const typeErr = _checkType(field.name, val, field.type);
            if (typeErr) {
                errors.push(`[${typeName}] ${typeErr}`);
            }
        }
    }
    return {
        valid: errors.length === 0,
        errors,
    };
}
function _checkType(fieldName, val, expected) {
    const actual = typeof val;
    const isArr = Array.isArray(val);
    switch (expected) {
        case 'string':
            if (actual !== 'string')
                return `${fieldName} 应为 string，实际为 ${actual}`;
            break;
        case 'number':
            if (actual !== 'number')
                return `${fieldName} 应为 number，实际为 ${actual}`;
            break;
        case 'boolean':
            if (actual !== 'boolean')
                return `${fieldName} 应为 boolean，实际为 ${actual}`;
            break;
        case 'timestamp':
            if (actual !== 'number' && !(actual === 'string' && !isNaN(Date.parse(val)))) {
                return `${fieldName} 应为 timestamp (number 或 ISO string)`;
            }
            break;
        case 'string[]':
            if (!isArr || !val.every((v) => typeof v === 'string')) {
                return `${fieldName} 应为 string[]`;
            }
            break;
        case 'number[]':
            if (!isArr || !val.every((v) => typeof v === 'number')) {
                return `${fieldName} 应为 number[]`;
            }
            break;
    }
    return null;
}
//# sourceMappingURL=schema-validator.js.map